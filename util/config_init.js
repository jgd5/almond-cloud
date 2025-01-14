// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

// This file must be imported by all processes before any other module is required

// base config
const Config = require('../config');

// load configuration overrides for non-secret data
try {
    Object.assign(Config, require('../custom_config'));
} catch(e) {
    if (e.code !== 'MODULE_NOT_FOUND')
        throw e;
    // ignore if there is no file
}

// load configuration overrides for secret data
try {
    Object.assign(Config, require('/etc/almond-cloud/config'));
} catch(e) {
    if (e.code !== 'MODULE_NOT_FOUND')
        throw e;
    // ignore if there is no file
}

// legacy configuration override
try {
    Object.assign(Config, require('../secret_config'));
} catch(e) {
    if (e.code !== 'MODULE_NOT_FOUND')
        throw e;
    // ignore if there is no file
}

if (Config.WITH_THINGPEDIA !== 'embedded' && Config.WITH_THINGPEDIA !== 'external')
    throw new Error('Invalid configuration, WITH_THINGPEDIA must be either embedded or external');
if (Config.WITH_THINGPEDIA === 'embedded') // ignore whatever setting is there
    Config.THINGPEDIA_URL = '/thingpedia';
if (Config.WITH_LUINET !== 'embedded' && Config.WITH_LUINET !== 'external')
    throw new Error('Invalid configuration, WITH_LUINET must be either embedded or external');
