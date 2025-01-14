#!/usr/bin/env node
// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2018 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Silei Xu <silei@cs.stanford.edu>
//         Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

// load thingpedia to initialize the polyfill
require('thingpedia');

process.on('unhandledRejection', (up) => { throw up; });
require('../util/config_init');

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const path = require('path');

const logger = require('morgan');
const bodyParser = require('body-parser');
const Prometheus = require('prom-client');

const SendMail = require('../util/sendmail');
const db = require('../util/db');
const Metrics = require('../util/metrics');
const modelsModel = require('../model/nlp_models');
const errorHandling = require('../util/error_handling');
const platform = require('../util/platform');

const Job = require('./training_job');

const Config = require('../config');

const JOB_TYPES = ['update-dataset', 'train'];

class TrainingDaemon {
    constructor() {
        this._next_id = 0;
        this._queues = {};
        for (let jobType of JOB_TYPES) {
            // last: last completed job of this type (for post-mortem debugging)
            // current: job in progress
            // next: jobs with no dependencies that are waiting in the queue
            // waiting: jobs that are waiting on a dependency

            this._queues[jobType] = {
                last: null,
                lastSuccess: {},
                current: null,
                next: [],
                waiting: [],
            };
        }
        this._dependencies = new Map;
    }

    _addDependency(job) {
        if (job.dependsOn === null || job.dependsOn === undefined)
            return;
        if (this._dependencies.has(job.dependsOn))
            this._dependencies.get(job.dependsOn).push(job);
        else
            this._dependencies.set(job.dependsOn, [job]);
    }

    save() {
        fs.writeFileSync('jobs.json', JSON.stringify({
            next_id: this._next_id,
            queues: this._queues
        }));
    }

    async loadExistingJobs() {
        try {
            let data = fs.readFileSync('jobs.json');
            let parsed = JSON.parse(data);
            this._next_id = parsed.next_id || 0;
            const queues = parsed.queues || {};
            for (let jobType in queues) {
                const queue = queues[jobType];

                if (queue.last)
                    this._queues[jobType].last = Job.load(this, queue.last);

                for (let key in queue.lastSuccess) {
                    const jobData = queue.lastSuccess[key];
                    if (queue.last && queue.last.id === jobData.id)
                        this._queues[jobType].lastSuccess[key] = this._queues[jobType].last;
                    else
                        this._queues[jobType].lastSuccess[key] = Job.load(this, jobData);
                }
                if (queue.current)
                    this._queues[jobType].current = Job.load(this, queue.current);
                this._queues[jobType].next = (queue.next || []).map((j) => Job.load(this, j));

                this._queues[jobType].waiting = (queue.waiting || []).map((j) => Job.load(this, j));

                // add dependency of waiting jobs to our internal data structures
                // note that we would not have dependencies for jobs in status last, current or
                // next, by definition
                // (their dependsOn fields might be !== null, but the corresponding job completed)
                for (let job of this._queues[jobType].waiting)
                    this._addDependency(job);
            }
            for (let jobType in queues) {
                // we crashed so the current job necessarily failed
                if (this._queues[jobType].current)
                    this._queues[jobType].current.fail(new Error('Master process failed'));
            }

            this.save();

            setImmediate(() => {
                for (let jobType in queues)
                    this._startNextJob(jobType);
            });
        } catch(e) {
            if (e.code === 'ENOENT')
                return;
            throw e;
        }
    }

    recordDuration(job, taskName, duration) {
        // FIXME do something with it
    }

    _notifyFailure(job) {
        const mailOptions = {
            from: Config.EMAIL_FROM_TRAINING,
            to: Config.EMAIL_TO_ADMIN,
            subject: `Training Job ${job.id} failed`,
            text: `Training Job ${job.id}, of type ${job.jobType}, for devices [${job.forDevices.join(', ')}] (@${job.modelTag}/${job.language}), failed.

The error reported was: ${job.error}.
Check the logs for further information.`
        };
        SendMail.send(mailOptions).catch((e) => {
            console.error(`Failed to send notification email: ${e.message}`);
        });
    }

    jobComplete(job) {
        fs.appendFileSync('jobs_history', JSON.stringify(job) + '\n');

        const current = this._queues[job.jobType].current;
        // nobody likes races
        if (job !== current)
            return;
        this._queues[job.jobType].last = job;
        if (job.status === 'success')
            this._queues[job.jobType].lastSuccess[job.modelTag + '/' + job.language] = job; //'
        this._queues[job.jobType].current = null;

        const dependents = this._dependencies.get(job.id) || [];
        this._dependencies.delete(job.id);
        console.log(`Dependencies of job ${job.id}: [${dependents.map((d) => d.id).join(', ')}]`);
        let success = true;
        if (job.status === 'failed' || job.status === 'error') {
            console.log(job.error);
            if (job.error !== `Dependency failed` && job.error !== `Killed`)
                this._notifyFailure(job);
            success = false;
        }

        let toSchedule = new Set();
        toSchedule.add(job.jobType);
        for (let dep of dependents) {
            const waitIndex = this._queues[dep.jobType].waiting.indexOf(dep);
            assert(waitIndex >= 0);

            this._queues[dep.jobType].waiting.splice(waitIndex, 1);
            dep.data.dependsOn = null;

            if (success) {
                this._queues[dep.jobType].next.push(dep);
                toSchedule.add(dep.jobType);
            } else {
                setImmediate(() => {
                    dep.fail(new Error(`Dependency failed`));
                });
            }
        }
        this.save();

        setImmediate(() => {
            for (let jobType of toSchedule)
                this._startNextJob(jobType);
        });
    }

    _startNextJob(jobType) {
        const queue = this._queues[jobType];

        if (queue.current !== null)
            return;
        if (queue.next.length === 0)
            return;
        const next = queue.next.shift();
        queue.current = next;
        next.start();
    }

    _queueOrMergeJob(forDevices, jobType, language, modelTag, dependsOn, modelInfo) {
        const queue = this._queues[jobType];
        for (let candidate of queue.next) {
            if (candidate.language === language &&
                candidate.modelTag === modelTag &&
                candidate.dependsOn === dependsOn) {
                candidate.addDevices(forDevices);
                return candidate.id;
            }
        }
        for (let candidate of queue.waiting) {
            if (candidate.language === language &&
                candidate.modelTag === modelTag &&
                candidate.dependsOn === dependsOn) {
                candidate.addDevices(forDevices);
                return candidate.id;
            }
        }

        let newjob = new Job(this, this._next_id++,
            jobType, forDevices, language, modelTag, dependsOn, modelInfo);
        if (dependsOn !== null) {
            queue.waiting.push(newjob);
            this._addDependency(newjob);
        } else {
            queue.next.push(newjob);
        }
        console.log(`Queued ${jobType} job ${newjob.id} for model @${modelTag}/${language}`);

        setImmediate(() => {
            this._startNextJob(jobType);
        });
        return newjob.id;
    }

    async scheduleJob(jobTemplate) {
        let forDevices = jobTemplate.forDevices;
        if (forDevices !== null && (!Array.isArray(forDevices) || forDevices.length === 0))
            throw new Error('forDevices must be an array of strings');
        let language = jobTemplate.language || 'en';
        let jobType = jobTemplate.jobType || 'train';

        const affectedModels = await db.withClient((dbClient) => {
            if (jobTemplate.modelTag)
                return modelsModel.getByTag(dbClient, language, jobTemplate.modelTag);
            else if (forDevices === null)
                return modelsModel.getForLanguage(dbClient, language);
            else
                return modelsModel.getForDevices(dbClient, language, forDevices);
        });

        if (jobType === 'train' || jobType === 'train-only') {
            let dependsOn = null;
            if (jobType !== 'train-only') {
                // there is only one dataset (per language) for all models, so we only queue
                // one update-dataset job
                dependsOn = this._queueOrMergeJob(forDevices || [], 'update-dataset',
                    language, 'default', null, null);
            }

            for (let modelInfo of affectedModels)
                this._queueOrMergeJob([], 'train', language, modelInfo.tag, dependsOn, modelInfo);
        } else if (jobType === 'update-dataset') {
            await this._queueOrMergeJob(forDevices || [], 'update-dataset', language, 'default', null);
        } else {
            throw new Error(`Invalid job type ${jobType}`);
        }

        await this.save();
    }

    initFrontend() {
        const app = express();

        app.set('port', process.env.PORT || 8090);
        app.set('views', path.join(__dirname, 'views'));
        app.set('view engine', 'pug');
        app.enable('trust proxy');
        app.use(bodyParser.json());
        app.use(bodyParser.urlencoded({ extended: true }));

        app.use(logger('dev'));
        if (Config.ENABLE_PROMETHEUS)
            Metrics(app);

        app.use((req, res, next) => {
            if (req.query.access_token === Config.TRAINING_ACCESS_TOKEN) {
                next();
                return;
            }
            if (req.headers.authorization !== `Bearer ${Config.TRAINING_ACCESS_TOKEN}`) {
                res.status(401).json({error:'Not Authorized'});
                return;
            }
            next();
        });

        app.get('/jobs/metrics', async (req, res, next) => {
            const queue = this._queues.train;

            const out = {};
            for (let key in queue.lastSuccess)
                out[key] = queue.lastSuccess[key].metrics;
            res.json(out);
        });

        app.post('/jobs/create', async (req, res, next) => { //'
            try {
                let id = await this.scheduleJob(req.body);
                res.json({result:'scheduled', id: id });
            } catch(e) {
                console.error(e);
                res.status(400).json({error: e.message, code: e.code});
            }
        });
        app.post('/jobs/kill', async (req, res, next) => {
            const id = req.body.id;
            let found = false;
            for (let jobType in this._queues) {
                const queue = this._queues[jobType];
                if (queue.current && queue.current.id === id) {
                    queue.current.kill();
                    found = true;
                    break;
                }
                for (let i = 0; i < queue.next.length; i++) {
                     let job = queue.next[i];
                     if (job.id === id) {
                         queue.next.splice(i, 1);
                         job.fail(new Error(`Killed`));
                         found = true;
                         break;
                     }
                }
                if (found)
                    break;
                for (let i = 0; i < queue.waiting.length; i++) {
                     let job = queue.waiting[i];
                     if (job.id === id) {
                         queue.waiting.splice(i, 1);
                         const dependencies = this._dependencies.get(job.dependsOn) || [];
                         const depIndex = dependencies.indexOf(job);
                         if (depIndex >= 0)
                             dependencies.splice(depIndex, 1);

                         job.fail(new Error(`Killed`));
                         found = true;
                         break;
                     }
                }
                if (found)
                    break;
            }
            if (found)
                res.json({result:'killed'});
            else
                res.status(404).json({result:'not_found'});
        });
        app.get('/jobs', (req, res) => {
            let jobs = {};
            for (let jobType in this._queues) {
                const queue = this._queues[jobType];

                const into = jobs[jobType] = [];
                if (queue.current)
                    into.push(queue.current);
                into.push(...queue.next);
                into.push(...queue.waiting);
            }
            res.json(jobs);
        });
        app.get('/jobs/last', (req, res) => {
            let jobs = {};
            for (let jobType in this._queues) {
                const queue = this._queues[jobType];
                jobs[jobType] = queue.last;
            }

            res.json(jobs);
        });
        app.get('/jobs/current', (req, res) => {
            let jobs = {};
            for (let jobType in this._queues) {
                const queue = this._queues[jobType];
                jobs[jobType] = queue.current;
            }
            res.json(jobs);
        });
        app.get('/jobs/:language/:forDevice', (req, res) => {
            let jobs = {};

            for (let jobType in this._queues) {
                const queue = this._queues[jobType];

                if (queue.current !== null &&
                    queue.current.language === req.params.language &&
                    (!queue.current.modelDevices || queue.current.modelDevices.indexOf(req.params.forDevice) >= 0) &&
                    (queue.current.forDevices.length === 0 || queue.current.forDevices.some((d) => d === req.params.forDevice))) {
                    jobs[jobType] = queue.current;
                    continue;
                }

                for (let candidate of queue.next.concat(queue.waiting)) {
                    if (candidate.language === req.params.language &&
                        (!candidate.modelDevices || candidate.modelDevices.indexOf(req.params.forDevice) >= 0) &&
                        (candidate.forDevices.length === 0 || candidate.forDevices.some((d) => d === req.params.forDevice))) {
                        jobs[jobType] = candidate;
                        break;
                    }
                }
            }
            res.json(jobs);
        });

        app.use('/', (req, res) => {
            res.status(404).json({ error: 'Invalid endpoint' });
        });
        app.use(errorHandling.json);

        app.listen(app.get('port'));
    }
}

function main() {
    platform.init();
    const daemon = new TrainingDaemon();

    daemon.loadExistingJobs();
    daemon.initFrontend();

    if (Config.ENABLE_PROMETHEUS)
        Prometheus.collectDefaultMetrics();
}
main();
