// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Thingpedia
//
// Copyright 2018 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const fs = require('fs');
const util = require('util');
const JSZip = require('jszip');
const ThingTalk = require('thingtalk');
const stream = require('stream');
const deq = require('deep-equal');

const model = require('../model/device');
const schemaModel = require('../model/schema');
const exampleModel = require('../model/example');

const user = require('./user');

const tokenizer = require('./tokenize');
const graphics = require('../almond/graphics');
const colorScheme = require('./color_scheme');

const Validation = require('./validation');
const code_storage = require('./code_storage');
const SchemaUtils = require('./manifest_to_schema');
const DatasetUtils = require('./dataset');
const FactoryUtils = require('./device_factories');

function areMetaIdentical(one, two) {
    for (let what of ['queries', 'actions']) {
        const oneKeys = Object.keys(one[what]).sort();
        const twoKeys = Object.keys(two[what]).sort();
        if (oneKeys.length !== twoKeys.length)
            return false;
        for (let i = 0; i < oneKeys.length; i++) {
            if (oneKeys[i] !== twoKeys[i])
                return false;

            // ignore confirmation remote in comparison
            one[what][oneKeys[i]].confirmation_remote = two[what][twoKeys[i]].confirmation_remote;
            if (!deq(one[what][oneKeys[i]], two[what][twoKeys[i]], { strict: true }))
                return false;
        }
    }

    return true;
}

async function ensurePrimarySchema(dbClient, name, classDef, req, approve) {
    const metas = SchemaUtils.classDefToSchema(classDef);

    return schemaModel.getByKind(dbClient, classDef.kind).then(async (existing) => {
        if (existing.owner !== req.user.developer_org &&
            req.user.developer_status < user.DeveloperStatus.ADMIN)
            throw new Error(req._("Not Authorized"));

        const existingMeta = (await schemaModel.getMetasByKindAtVersion(dbClient, classDef.kind, existing.developer_version, 'en'))[0];
        if (areMetaIdentical(existingMeta, metas)) {
            console.log('Skipped updating of schema: identical to previous version');
            return [existing.id, false];
        }

        var obj = {
            kind_canonical: tokenizer.tokenize(name).join(' '),
            developer_version: existing.developer_version + 1
        };
        if (approve)
            obj.approved_version = obj.developer_version;

        await schemaModel.update(dbClient, existing.id, existing.kind, obj, metas);
        return [existing.id, true];
    }, async (e) => {
        var obj = {
            kind: classDef.kind,
            kind_canonical: tokenizer.tokenize(name).join(' '),
            kind_type: 'primary',
            owner: req.user.developer_org
        };
        if (req.user.developer_status < user.DeveloperStatus.TRUSTED_DEVELOPER || !approve) {
            obj.approved_version = null;
            obj.developer_version = 0;
        } else {
            obj.approved_version = 0;
            obj.developer_version = 0;
        }

        const schema = await schemaModel.create(dbClient, obj, metas);
        return [schema.id, true];
    });
}

function exampleToCode(example) {
    const clone = example.clone();
    clone.id = -1;
    clone.utterances = [];
    clone.preprocessed = [];
    clone.metadata = {};
    return clone.prettyprint();
}

async function ensureDataset(dbClient, schemaId, dataset, datasetSource) {
    /* This functions does three things:

       - it fetches the list of existing examples in the database
       - it matches the IDs against the examples in the dataset file
         and updates the database
       - it creates fresh examples for secondary utterances
    */

    const existing = new Map;
    const toDelete = new Set;

    const old = await exampleModel.getBaseBySchema(dbClient, schemaId, dataset.language);
    const oldDataset = DatasetUtils.examplesToDataset(dataset.name.substring(1), dataset.language, old, { editMode: true });

    // if the datasets are byte by byte identical, skip everything and return false
    // this covers the case where the user did not touch the file at all
    if (datasetSource.replace(/\r\n/g, '\n').trim() === oldDataset.trim())
        return false;

    for (let row of old) {
        existing.set(row.id, row);
        toDelete.add(row.id);
    }

    const toCreate = [];
    const toUpdate = [];

    for (let example of dataset.examples) {
        const code = exampleToCode(example);

        if (example.id >= 0) {
            if (existing.has(example.id)) {
                toDelete.delete(example.id);
                if (existing.utterance !== example.utterances[0] ||
                    existing.target_code !== code) {
                    toUpdate.push({ id: example.id,
                                    utterance: example.utterances[0],
                                    target_code: code });
                }
            } else {
                example.id = -1;
            }
        }
        if (example.id < 0) {
            toCreate.push({
                utterance: example.utterances[0],
                target_code: code
            });
        }

        for (let i = 1; i < example.utterances.length; i++) {
            toCreate.push({
                utterance: example.utterances[i],
                target_code: code
            });
        }
    }

    if (toDelete.length === 0 && toCreate.length === 0 && toUpdate.length === 0)
        return false;

    await Promise.all([
        Validation.tokenizeAllExamples('en', toUpdate),
        Validation.tokenizeAllExamples('en', toCreate)
    ]);

    await Promise.all([
        exampleModel.deleteMany(dbClient, Array.from(toDelete)),
        Promise.all(toUpdate.map((ex) => {
            return exampleModel.update(dbClient, ex.id, ex);
        })),
        exampleModel.createMany(dbClient, toCreate.map((ex) => {
            return ({
                schema_id: schemaId,
                utterance: ex.utterance,
                preprocessed: ex.preprocessed,
                target_code: ex.target_code,
                target_json: '', // FIXME
                type: 'thingpedia',
                language: dataset.language,
                is_base: 1,
                flags: 'template'
            });
        }))
    ]);
    return true;
}

function uploadZipFile(req, obj, stream) {
    var zipFile = new JSZip();

    return Promise.resolve().then(() => {
        // unfortunately JSZip only loads from memory, so we need to load the entire file
        // at once
        // this is somewhat a problem, because the file can be up to 30-50MB in size
        // we just hope the GC will get rid of the buffer quickly

        var buffers = [];
        var length = 0;
        return new Promise((callback, errback) => {
            stream.on('data', (buffer) => {
                buffers.push(buffer);
                length += buffer.length;
            });
            stream.on('end', () => {
                callback(Buffer.concat(buffers, length));
            });
            stream.on('error', errback);
        });
    }).then((buffer) => {
        return zipFile.loadAsync(buffer, { checkCRC32: false });
    }).then(() => {
        var packageJson = zipFile.file('package.json');
        if (!packageJson)
            throw new Error(req._("package.json missing from device zip file"));

        return packageJson.async('string');
    }).then((text) => {
        try {
            var parsed = JSON.parse(text);
        } catch(e) {
            throw new Error("Invalid package.json: SyntaxError at line " + e.lineNumber + ": " + e.message);
        }
        if (!parsed.name || !parsed.main)
            throw new Error(req._("Invalid package.json (missing name or main)"));

        parsed['thingpedia-version'] = obj.developer_version;

        zipFile.file('package.json', JSON.stringify(parsed));

        return code_storage.storeZipFile(zipFile.generateNodeStream({ compression: 'DEFLATE',
                                                                      type: 'nodebuffer',
                                                                      platform: 'UNIX'}),
                                         obj.primary_kind, obj.developer_version);
    }).catch((e) => {
        console.error('Failed to upload zip file to S3: ' + e);
        console.error(e.stack);
        throw e;
    });
}

function uploadJavaScript(req, obj, stream) {
    var zipFile = new JSZip();

    return Promise.resolve().then(() => {
        zipFile.file('package.json', JSON.stringify({
            name: obj.primary_kind,
            author: req.user.username + '@thingpedia.stanford.edu',
            main: 'index.js',
            'thingpedia-version': obj.developer_version
        }));
        zipFile.file('index.js', stream);
        return code_storage.storeZipFile(zipFile.generateNodeStream({ compression: 'DEFLATE',
                                                                      type: 'nodebuffer',
                                                                      platform: 'UNIX'}),
                                         obj.primary_kind, obj.developer_version);
    }).catch((e) => {
        console.error('Failed to upload zip file to S3: ' + e);
        console.error(e.stack);
        throw e;
    });
}

function isDownloadable(classDef) {
    const loader = classDef.loader;
    return !classDef.is_abstract &&
        Validation.JAVASCRIPT_MODULE_TYPES.has(loader.module) &&
        loader.module !== 'org.thingpedia.builtin' &&
        loader.module !== 'org.thingpedia.embedded';
}

function getCategory(classDef) {
    if (classDef.annotations.system && classDef.annotations.system.toJS())
        return 'system';
    if (classDef.is_abstract)
        return 'system';

    if (classDef.loader.module === 'org.thingpedia.builtin') {
        switch (classDef.kind) {
        case 'org.thingpedia.builtin.thingengine.gnome':
        case 'org.thingpedia.builtin.thingengine.phone':
        case 'org.thingpedia.builtin.thingengine.home':
            return 'physical';
        }
    }

    switch (classDef.config.module) {
    case 'org.thingpedia.config.builtin':
    case 'org.thingpedia.config.none':
        return 'data';
    case 'org.thingpedia.config.discovery.bluetooth':
    case 'org.thingpedia.config.discovery.upnp':
        return 'physical';
    default:
        return 'online';
    }
}

async function uploadIcon(primary_kind, iconPath, deleteAfterwards = true) {
    try {
        var image = graphics.createImageFromPath(iconPath);
        image.resizeFit(512, 512);
        const [stdout,] = await image.stream('png');

        // we need to consume the stream twice: once
        // to upload to S3 / store on reliable file system
        // and the other time to compute the color scheme
        //
        // in theory, nodejs supports this
        // in practice, it depends heavily on what each library
        // is doing, and I don't want to dig too deep in their
        // source code (plus it could break at any moment)
        //
        // instead, we create a separate PassThrough for each
        // destination

        const pt1 = new stream.PassThrough();
        stdout.pipe(pt1);

        const pt2 = new stream.PassThrough();
        stdout.pipe(pt2);

        // we must run the two consumers in parallel, or one of
        // the streams will be forced to buffer everything in memory
        // and we'll be sad
        const [,result] = await Promise.all([
            code_storage.storeIcon(pt1, primary_kind),
            colorScheme(pt2, primary_kind)
        ]);
        return result;
    } finally {
        if (deleteAfterwards)
            await util.promisify(fs.unlink)(iconPath);
    }
}

async function importDevice(dbClient, req, primary_kind, json, { owner = 0, zipFilePath = null, iconPath = null, approve = true }) {
    const device = {
        primary_kind: primary_kind,
        owner: owner,
        name: json.thingpedia_name,
        description: json.thingpedia_description,
        subcategory: json.subcategory,
        approved_version: (approve ? 0 : null),
        developer_version: 0
    };

    const classCode = json.class || migrateManifest(json, device);
    device.source_code = classCode;

    const datasetCode = json.dataset || DatasetUtils.examplesToDataset(primary_kind, 'en',
        json.examples, { editMode: true });

    const [classDef, dataset] = await Validation.validateDevice(dbClient, req, device, classCode, datasetCode);
    device.category = getCategory(classDef);

    const [schemaId,] = await ensurePrimarySchema(dbClient, device.name,
                                                  classDef, req, approve);
    await ensureDataset(dbClient, schemaId, dataset, datasetCode);
    const factory = FactoryUtils.makeDeviceFactory(classDef, device);

    classDef.annotations.version = ThingTalk.Ast.Value.Number(device.developer_version);
    classDef.annotations.package_version = ThingTalk.Ast.Value.Number(device.developer_version);
    const versionedInfo = {
        code: classDef.prettyprint(),
        factory: JSON.stringify(factory),
        downloadable: isDownloadable(classDef),
        module_type: classDef.is_abstract ? 'org.thingpedia.abstract' : classDef.loader.module
    };

    if (iconPath)
        Object.assign(device, await uploadIcon(primary_kind, iconPath, false));

    await model.create(dbClient, device, classDef.extends || [],
                       classDef.annotations.child_types ?
                       classDef.annotations.child_types.toJS() : [],
                       FactoryUtils.getDiscoveryServices(classDef),
                       versionedInfo);

    if (versionedInfo.downloadable && zipFilePath !== null) {
        if (zipFilePath.endsWith('.js'))
            await uploadJavaScript(req, device, fs.createReadStream(zipFilePath));
        else
            await uploadZipFile(req, device, fs.createReadStream(zipFilePath));
    }

    return device;
}

function migrateManifest(code, device) {
    const isJSON = typeof code === 'object' || /^\s*\{/.test(code);
    if (!isJSON) // already migrated
        return code;

    let ast = typeof code === 'string' ? JSON.parse(code) : code;

    ast.system = device.category === 'system';
    return ThingTalk.Ast.fromManifest(device.primary_kind, ast).prettyprint();
}


module.exports = {
    ensurePrimarySchema,
    ensureDataset,

    isDownloadable,
    getCategory,
    uploadZipFile,
    uploadJavaScript,
    uploadIcon,

    importDevice,

    migrateManifest,
};
