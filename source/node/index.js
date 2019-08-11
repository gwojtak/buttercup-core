const iocane = require("iocane");
const Datasources = require("@buttercup/datasources");
const Credentials = require("@buttercup/credentials");

module.exports = {
    Archive: require("./Archive.js"),
    ArchiveManager: require("./archiveManagement/ArchiveManager.js"),
    ArchiveSource: require("./archiveManagement/ArchiveSource.js"),
    Workspace: require("./Workspace.js"),

    Credentials,
    Datasources,

    Group: require("./Group.js"),
    Entry: require("./Entry.js"),

    Flattener: require("./Flattener.js"),
    EntryFinder: require("./EntryFinder.js"),

    storage: {
        StorageInterface: require("./storage/StorageInterface.js"),
        MemoryStorageInterface: require("./storage/MemoryStorageInterface.js")
    },

    tools: {
        describe: require("./tools/describe.js"),
        encoding: require("./tools/encoding.js"),
        entry: require("./tools/entry.js"),
        export: require("./tools/export.js"),
        permissions: require("./tools/permissions.js"),
        request: require("./tools/request.js"),
        signing: require("@buttercup/signing"),
        searching: {
            instance: require("./tools/vaultSearch.js"),
            raw: require("./tools/rawVaultSearch.js")
        },
        uuid: require("./tools/uuid.js")
    },

    vendor: {
        dropbox: Datasources.dropboxClientPatcher,
        iocane,
        webdav: Datasources.webdav
    }
};
