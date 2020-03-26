const EventEmitter = require("eventemitter3");
const ChannelQueue = require("@buttercup/channel-queue");
const MemoryStorageInterface = require("../storage/MemoryStorageInterface.js");

const DEFAULT_AUTO_UPDATE_DELAY = 1000 * 60 * 2.5; // 2.5 mins
const STORAGE_KEY_PREFIX = "bcup_vaultmgr_";
const STORAGE_KEY_PREFIX_TEST = /^bcup_vaultmgr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

class VaultManager extends EventEmitter {
    constructor(opts = {}) {
        super();
        const {
            autoUpdate = true,
            autoUpdateDelay = DEFAULT_AUTO_UPDATE_DELAY,
            cacheStorage = new MemoryStorageInterface(),
            sourceStorage = new MemoryStorageInterface()
        } = opts;
        this._sources = [];
        this._cacheStorage = cacheStorage;
        this._sourceStorage = sourceStorage;
        this._queue = new ChannelQueue();
        this._autoUpdateEnabled = autoUpdate;
        this._autoUpdateDelay = autoUpdateDelay;
        this._autoUpdateTimer = null;
        this._initialised = false;
    }

    get sources() {
        return [...this._sources];
    }

    /**
     * @typedef {Object} AddSourceOptions
     * @property {Number=} order Optional order override
     */

    /**
     * Add a VaultSource to the VaultManager
     * - The vault manager will then provide a management
     * platform for the source, including storage access and
     * event aggregation.
     * @param {VaultSource} source The source to add
     * @param {AddSourceOptions=} opts Options for adding the
     *  source
     * @returns {Promise}
     * @memberof VaultManager
     */
    async addSource(source, opts = {}) {
        const { order: orderOverride } = opts;
        const existing = this._sources.find(src => src.id === source.id);
        if (existing) return;
        await this.enqueueStateChange(async () => {
            source._vaultManager = this;
            this._sources.push(source);
            // Configure the order
            source._order = typeof orderOverride === "number" ? orderOverride : this.getNextOrder();
            // Attach event listeners
            const handleDetailsChange = event => {
                this.emit(`source:${event}`);
                this.emit("updated");
            };
            source.on("locked", details => handleDetailsChange("locked"));
            source.on("unlocked", details => handleDetailsChange("unlocked"));
            source.on("updated", () => this.dehydrate());
            const dehydratedString = await source.dehydrate();
            await this._storeDehydratedSource(source.id, dehydratedString);
            this.emit("sourcesUpdated");
        });
    }

    /**
     * Dehydrate all sources and write them to storage
     * @returns {Promise} A promise that resolves once all sources have been dehydrated
     * @memberof VaultManager
     */
    dehydrate() {
        return this.enqueueStateChange(() => {
            return Promise.all(this._sources.map(source => this.dehydrateSource(source)));
        });
    }

    /**
     * Dehydrate a single archive source
     * @param {String} sourceID The ID of the source
     * @returns {Promise} A promise that resolves once the source has been dehydrated
     * @memberof VaultManager
     */
    async dehydrateSource(sourceOrSourceID) {
        const source = typeof sourceOrSourceID === "string" ? this.getSourceForID(sourceOrSourceID) : sourceOrSourceID;
        const dehydratedString = await source.dehydrate();
        await this._storeDehydratedSource(source.id, dehydratedString);
    }

    /**
     * Enqueue an asychronous change of state
     * @param {Function} cb Callback to enqueue
     * @returns {Promise}
     * @memberof VaultManager
     */
    enqueueStateChange(cb) {
        return this._queue.channel("state").enqueue(cb);
    }

    /**
     * Get the next viable order number for a new source
     * @returns {Number} The new order
     * @memberof VaultManager
     */
    getNextOrder() {
        return Math.max(...this._sources.map(source => source._order)) + 1;
    }

    /**
     * Get a source for an ID
     * @param {String} sourceID The source ID
     * @returns {Vaultsource|null} The source with the matching ID or null if not found
     * @memberof VaultManager
     */
    getSourceForID(sourceID) {
        const source = this._sources.find(target => target.id && target.id === sourceID);
        return source || null;
    }

    /**
     * Get an array of sources that can be updated
     * @returns {Array.<VaultSource>}
     * @memberof VaultManager
     */
    getUpdateableSources() {
        return this._sources.filter(source => source.canBeUpdated());
    }

    /**
     * Initialise the vault manager
     * @memberof VaultManager
     */
    initialise() {
        if (this._initialised) return;
        this._startAutoUpdateTimer();
        this._initialised = true;
    }

    /**
     * Rehydrate sources from storage
     * @returns {Promise} A promise that resolves once rehydration has completed
     * @memberof VaultManager
     * @throws {VError} Rejects if rehydrating from storage fails
     */
    async rehydrate() {
        const storageKeys = await this._sourceStorage.getAllKeys();
        await Promise.all(
            storageKeys
                .filter(key => STORAGE_KEY_PREFIX_TEST.test(key))
                .map(async key => {
                    const dehydratedSource = await this.storageInterface.getValue(key);
                    const source = VaultSource.rehydrate(dehydratedSource);
                    await this.addSource(source, {
                        order: source.order
                    });
                })
        );
        this.reorderSources();
        this.emit("sourcesUpdated");
    }

    /**
     * Remove a source from the storage
     * @param {String} sourceID The ID of the source to remove
     * @returns {Promise} A promise that resolves once the source has been removed
     * @memberof VaultManager
     */
    removeSource(sourceID) {
        return this.enqueueStateChange(async () => {
            const sourceIndex = this._sources.findIndex(source => source.id === sourceID);
            if (sourceIndex === -1) {
                throw new VError(`Failed removing source: No source found for ID: ${sourceID}`);
            }
            const source = this.sources[sourceIndex];
            source.removeAllListeners();
            this._sources.splice(sourceIndex, 1);
            this.emit("sourcesUpdated");
            await this.storageInterface.removeKey(`${STORAGE_KEY_PREFIX}${sourceID}`);
        });
    }

    /**
     * Reorder a source
     * @param {String} sourceID The ID of the source to reorder
     * @param {Number} position The 0-based position to move the source to
     * @memberof VaultManager
     * @throws {VError} Throws if no source is found
     */
    reorderSource(sourceID, position) {
        const source = this.getSourceForID(sourceID);
        if (!source) {
            throw new VError(`Failed reordering source: No source found for ID: ${sourceID}`);
        }
        if (position === source.order) {
            return;
        }
        const originalOrder = source.order;
        source.order = position;
        const movingUp = position < originalOrder;
        this.sources.forEach(otherSource => {
            if (otherSource.id !== sourceID) {
                if (movingUp && otherSource.order >= position) {
                    otherSource.order += 1;
                } else if (!movingUp && otherSource.order <= position) {
                    otherSource.order -= 1;
                }
            }
        });
        this.reorderSources();
    }

    /**
     * Reorder all sources
     * @memberof VaultManager
     */
    reorderSources() {
        this.sources.sort((sourceA, sourceB) => {
            if (sourceA.order > sourceB.order) {
                return 1;
            } else if (sourceB.order > sourceA.order) {
                return -1;
            }
            return 0;
        });
        this.sources.forEach((source, index) => {
            source.order = index;
        });
        this.emit("sourcesUpdated");
    }

    /**
     * Toggle auto updating of sources
     * @param {Boolean=} enable Enable or disable auto updating. Leave empty
     *  to invert the setting
     * @param {Number=} delay Milliseconds between updates
     * @memberof VaultManager
     */
    toggleAutoUpdating(enable = !this._autoUpdateEnabled, delay = DEFAULT_AUTO_UPDATE_DELAY) {
        if (enable) {
            this._autoUpdateDelay = delay;
            this._startAutoUpdateTimer();
        } else {
            this._autoUpdateDelay = null;
            clearTimeout(this._autoUpdateTimer);
            this._autoUpdateTimer = null;
        }
    }

    _autoUpdateSources() {
        this.emit("autoUpdateStart");
        return this.enqueueStateChange(async () => {
            const updateableSources = this.getUpdateableSources();
            if (updateableSources.length <= 0) {
                return;
            }
            await Promise.all(
                updateableSources.map(source =>
                    source.workspace.update().catch(err => {
                        // we ignore auto-update errors
                        console.error(`Failed auto-updating source: ${source.id}`);
                        this.emit("autoUpdateFailed", { source });
                    })
                )
            );
            this.emit("autoUpdateStop");
        });
    }

    _startAutoUpdateTimer() {
        clearTimeout(this._autoUpdateTimer);
        this._autoUpdateTimer = setTimeout(() => {
            this._autoUpdateSources().then(() => {
                if (this._autoUpdateEnabled) {
                    this._startAutoUpdateTimer();
                }
            });
        }, this._autoUpdateDelay);
    }

    _storeDehydratedSource(id, dehydratedSource) {
        return this._sourceStorage.setValue(`${STORAGE_KEY_PREFIX}${id}`, dehydratedSource);
    }
}

module.exports = VaultManager;
