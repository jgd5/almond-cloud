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

const db = require('../util/db');
const model = require('../model/user');
const user = require('../util/user');
const EngineManager = require('../almond/enginemanagerclient');

var router = express.Router();

// special case omlet to store the omlet ID
router.get('/oauth2/callback/org.thingpedia.builtin.omlet', user.redirectLogIn, (req, res, next) => {
    EngineManager.get().getEngine(req.user.id).then((engine) => {
        return engine.devices.factory.then((devFactory) => {
            var saneReq = {
                httpVersion: req.httpVersion,
                url: req.url,
                headers: req.headers,
                rawHeaders: req.rawHeaders,
                method: req.method,
                query: req.query,
                body: req.body,
                session: req.session,
            };
            return devFactory.runOAuth2('org.thingpedia.builtin.omlet', saneReq);
        }).then(() => {
            return engine.messaging.account;
        });
    }).then((omletId) => {
        return db.withTransaction((dbClient) => {
            return model.update(dbClient, req.user.id, { omlet_id: omletId });
        });
    }).then(() => {
        if (req.session['device-redirect-to']) {
            res.redirect(303, req.session['device-redirect-to']);
            delete req.session['device-redirect-to'];
        } else {
            res.redirect(303, '/me');
        }
    }).catch((e) => {
        console.log(e.stack);
        res.status(400).render('error', { page_title: req._("Thingpedia - Error"),
                                          message: e });
    }).done();
});

router.get('/oauth2/callback/:kind', user.redirectLogIn, (req, res, next) => {
    const kind = req.params.kind;

    EngineManager.get().getEngine(req.user.id).then((engine) => {
        return engine.devices.factory;
    }).then((devFactory) => {
        var saneReq = {
            httpVersion: req.httpVersion,
            url: req.url,
            headers: req.headers,
            rawHeaders: req.rawHeaders,
            method: req.method,
            query: req.query,
            body: req.body,
            session: req.session,
        };
        return devFactory.runOAuth2(kind, saneReq);
    }).then(() => {
        if (req.session['device-redirect-to']) {
            res.redirect(303, req.session['device-redirect-to']);
            delete req.session['device-redirect-to'];
        } else {
            res.redirect(303, '/me');
        }
    }).catch((e) => {
        res.status(400).render('error', { page_title: req._("Thingpedia - Error"),
                                          message: e });
    }).done();
});

module.exports = router;