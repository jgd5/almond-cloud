// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const express = require('express');

const Config = require('../config');

const user = require('../util/user');
const EngineManager = require('../almond/enginemanagerclient');

var router = express.Router();

function getAllApps(req, engine) {
    return engine.apps.getAllApps().then((apps) => {
        return Promise.all(apps.map((a) => {
            return Promise.all([a.uniqueId, a.description, a.error]).then(([uniqueId, description, error]) => {
                const app = { uniqueId: uniqueId, description: description || req._("Some app"),
                              error: error };
                return app;
            });
        }));
    });
}

function getAllDevices(req, engine) {
    return engine.devices.getAllDevices().then((devices) => {
        return Promise.all(devices.map((d) => {
            return Promise.all([d.uniqueId, d.name, d.description, d.kind, d.ownerTier,
                                d.checkAvailable(),
                                d.isTransient,
                                d.hasKind('online-account'),
                                d.hasKind('data-source'),
                                d.hasKind('thingengine-system')])
                .then(([uniqueId, name, description, kind,
                        ownerTier,
                        available,
                        isTransient,
                        isOnlineAccount,
                        isDataSource,
                        isThingEngine]) => {
                    return { uniqueId: uniqueId, name: name || req._("Unknown device"),
                             description: description || req._("Description not available"),
                             kind: kind,
                             ownerTier: ownerTier,
                             available: available,
                             isTransient: isTransient,
                             isOnlineAccount: isOnlineAccount,
                             isDataSource: isDataSource,
                             isPhysical: !isOnlineAccount && !isDataSource,
                             isThingEngine: isThingEngine };
                });
        }));
    }).then((devinfo) => {
        return devinfo.filter((d) => !d.isThingEngine);
    });
}

async function getInfo(req) {
    const isRunning = await EngineManager.get().isRunning(req.user.id);
    if (!isRunning)
        return [isRunning, [], []];

    const engine = await EngineManager.get().getEngine(req.user.id);
    const [appinfo, devinfo] = await Promise.all([getAllApps(req, engine), getAllDevices(req, engine)]);
    devinfo.sort((d1, d2) => {
        if (d1.name < d2.name)
            return -1;
        else if (d1.name > d2.name)
            return 1;
        else
            return 0;
    });
    return [isRunning, appinfo, devinfo];
}

router.get('/', user.redirectLogIn, (req, res, next) => {
    getInfo(req).then(([isRunning, appinfo, devinfo]) => {
        res.render('my_stuff', { page_title: req._("Thingpedia - My Almond"),
                                 messages: req.flash('app-message'),
                                 csrfToken: req.csrfToken(),
                                 isRunning: isRunning,
                                 apps: appinfo,
                                 devices: devinfo,
                                 CDN_HOST: Config.CDN_HOST
                                });
    }).catch(next);
});

router.post('/', user.redirectLogIn, (req, res, next) => {
    getInfo(req).then(([isRunning, appinfo, devinfo]) => {
        res.render('my_stuff', { page_title: req._("Thingpedia - My Almond"),
            messages: req.flash('app-message'),
            csrfToken: req.csrfToken(),
            isRunning: isRunning,
            apps: appinfo,
            devices: devinfo,
            CDN_HOST: Config.CDN_HOST,
            command: req.body.command
        });
    }).catch(next);
});

router.post('/apps/delete', user.requireLogIn, (req, res, next) => {
    EngineManager.get().getEngine(req.user.id).then((engine) => {
        const id = req.body.id;
        return Promise.all([engine, engine.apps.getApp(id)]);
    }).then(([engine, app]) => {
        if (app === undefined) {
            res.status(404).render('error', { page_title: req._("Thingpedia - Error"),
                                              message: req._("Not found.") });
            return Promise.resolve();
        }

        return engine.apps.removeApp(app);
    }).then(() => {
        req.flash('app-message', "Application successfully deleted");
        res.redirect(303, '/me');
    }).catch(next);
});

router.get('/conversation', user.redirectLogIn, (req, res, next) => {
    res.render('my_conversation', { page_title: req._("Thingpedia - Web Almond") });
});

router.post('/conversation', user.redirectLogIn, (req, res) => {
    res.render('my_conversation', { page_title: req._("Thingpedia - Web Almond"), command: req.body.command });
});

module.exports = router;
