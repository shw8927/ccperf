// Author: Yohei Ueda <yohei@jp.ibm.com>

const cluster = require('cluster');
const program = require('commander');
const fs = require('fs');
const path = require('path');
const sdk = require('fabric-client');
const sdkutil = require('fabric-client/lib/utils.js');
const util = require('util');
const sprintf = require('sprintf-js').sprintf;
const yaml = require('js-yaml');
const request = require('request');

const logger = require('winston');
if (process.env.FABRIC_CONFIG_LOGLEVEL) {
    logger.level = process.env.FABRIC_CONFIG_LOGLEVEL;
}
function loadFile(filePath, baseDir) {
    if (!path.isAbsolute(filePath) && baseDir !== undefined) {
        filePath = path.join(baseDir, filePath);
    }
    return fs.readFileSync(filePath, 'utf8');
}

class MemoryKeyValueStore {
    constructor(options) {
        const self = this;
        logger.debug('MemoryKeyValueStore: constructor options=%j', options);
        self._store = new Map();
        return Promise.resolve(self);
    }

    getValue(name) {
        const value = Promise.resolve(this._store.get(name));
        logger.debug('MemoryKeyValueStore: getValue name=%j value=%j', name, value);
        return value;
    }

    setValue(name, value) {
        this._store.set(name, value);
        logger.debug('MemoryKeyValueStore: setValue name=%j value=%j', name, value);
        return Promise.resolve(value);
    }
}

async function getClient(profile, orgName) {
    const cryptoSuite = sdk.newCryptoSuite();
    const cryptoKeyStore = sdk.newCryptoKeyStore(MemoryKeyValueStore, {})
    cryptoSuite.setCryptoKeyStore(cryptoKeyStore);

    const client = sdk.loadFromConfig(profile);

    client.setCryptoSuite(cryptoSuite);
    const newStore = await new MemoryKeyValueStore();
    client.setStateStore(newStore);

    const org = profile.organizations[orgName];

    const userOpts = {
        username: "admin",
        mspid: org.mspid,
        cryptoContent: { signedCertPEM: org.signedCert.pem, privateKeyPEM: org.adminPrivateKey.pem },
        skipPersistence: false
    };

    const user = await client.createUser(userOpts);

    return client;
}


function roundDown(num, base) {
    return Math.floor(num / base) * base;
}

function roundUp(num, base) {
    return roundDown(num, base) + base;
}

function percentile(list, percent) {
    if (list.length == 0) {
        return 0.0;
    }
    list.sort((a, b) => a - b);
    nth = roundDown(list.length * percent, 1);
    return list[nth];
}

function average(list) {
    if (list.length == 0) {
        return 0.0;
    }
    let sum = 0;
    for (const item of list) {
        sum += item;
    }
    return sum / list.length;
}

function doRequest(options) {
    return new Promise(function (resolve, reject) {
        request(options, function (error, res, body) {
            if (!error && res.statusCode == 200) {
                resolve(body);
            } else {
                reject(error);
            }
        });
    });
}

async function master(config) {
    const client = await getClient(config.profile, config.orgName)
    const channel = client.getChannel(config.channelID);

    if (config.population) {
        const peer_name = channel.getPeers()[0].getName();
        const eventhub = channel.getChannelEventHub(peer_name);
        eventhub.connect(false);

        const tx_id = client.newTransactionID();

        p = new Promise(resolve => eventhub.registerTxEvent(tx_id.getTransactionID(),
            (txId, code, block_bumber) => resolve(txId),
            err => console.error('EventHub error ', err),
            { unregister: true }));

        const request = {
            chaincodeId: 'ccperf',
            fcn: 'populate',
            args: ['0', String(config.population), String(config.size)],
            txId: tx_id
        };

        const results = await channel.sendTransactionProposal(request);

        const proposalResponses = results[0];
        const proposal = results[1];
        const orderer_request = {
            txId: tx_id,
            proposalResponses: proposalResponses,
            proposal: proposal
        };

        await channel.sendTransaction(orderer_request);

        await p;
        eventhub.disconnect();
    }

    const start = Date.now() + 5000;

    if (config.grafana) {
        const description = util.format("Target:%d Processes:%d Duration:%d Type:%s Num:%d Size:%d", 1000 / config.interval * config.processes, config.processes, config.duration, config.type, config.num, config.size);

        const payload = {
            "dashboardId": 2,
            "time": start,
            "isRegion": true,
            "timeEnd": start + config.duration,
            "tags": [],
            "text": description
        }

        const requestOptions = {
            url: config.grafana,
            method: "POST",
            headers: {
                "Content-type": "application/json",
            },
            json: payload
        }

        const res = await doRequest(requestOptions).catch(err => { throw new Error(err) });
    }

    let prev_t = 0;

    const blockTable = {};
    let blockRegNum;
    let eventhub;
    let blocksLog;
    let blocksLogFirst = true;
    if (config.committingPeerName) {
        if (config.logdir) {
            const blocksLogPath = config.logdir + '/blocks.json';
            blocksLog = fs.createWriteStream(blocksLogPath, { flags: 'wx' });
            blocksLog.write('[\n');
        }

        eventhub = channel.getChannelEventHub(config.committingPeerName);
        eventhub.connect(false);
        blockRegNum = eventhub.registerBlockEvent(
            (block) => {
                // Example data structure of a filtered block:
                // {
                //   "channel_id": "mychannel",
                //   "number": "123",
                //   "filtered_transactions": [
                //     {
                //       "Data": "transaction_actions",
                //       "txid": "cd1c24b15e19e1923a1cda0fbd1a2db4528eafd6140d563e8ec9abdd5655bcc3",
                //       "type": "ENDORSER_TRANSACTION",
                //       "tx_validation_code": "VALID",
                //       "transaction_actions": {
                //         "chaincode_actions": []
                //       }
                //     }, ...]
                //  }
                const date = new Date();
                const now = date.getTime();
                if (prev_t == 0) {
                    prev_t = start;
                    return;
                }
                const txset = {}
                for (const tx of block.filtered_transactions) {
                    let txTypes = txset[tx.type];
                    if (txTypes === undefined) {
                        txTypes = {};
                        txset[tx.type] = txTypes;
                    }
                    let txResults = txTypes[tx.tx_validation_code];
                    if (txResults === undefined) {
                        txResults = []
                        txTypes[tx.tx_validation_code] = txResults;
                    }
                    txResults.push(tx.txid);
                }
                blockTable[block.number] = { txset: txset, timestamp: now };
                const count = block.filtered_transactions.length;
                const tps = count / (now - prev_t) * 1000;
                console.error(sprintf('Block %d contains %d transaction(s). TPS is %.2f', block.number, count, tps));

                if (config.logdir) {
                    if (blocksLogFirst) {
                        blocksLogFirst = false;
                    } else {
                        blocksLog.write(',\n');
                    }
                    blocksLog.write(JSON.stringify({ timestamp: date, block: block }, undefined, 4));
                }

                prev_t = now;
            },
            (err) => {
                console.error('EventHub error ', err);
            }
        );
    }

    const txTable = {};

    cluster.on('message', (w, txStats) => {
        for (const txid in txStats) {
            txTable[txid] = txStats[txid];
        }
    });

    const promises = [];

    for (var i = 0; i < config.processes; i++) {
        config.delay = i * config.rampup / config.processes;
        const w = cluster.fork();
        w.on('online', () => {
            w.send({ config: config });
        });

        promises.push(new Promise((resolve, reject) => {
            w.on('exit', (code, signal) => {
                if (signal) {
                    reject(`Worker ${w.id} is killed by ${signal}`);
                } else if (code != 0) {
                    reject(`Worker ${w.id} exited with return code ${code}`);
                } else {
                    resolve();
                }
            });
        }));
    }

    await Promise.all(promises);
    await sleep(3000);

    // info = await channel.queryInfo();
    // height = Number(info.height)
    // block = await channel.queryBlock(height-1);

    if (config.committingPeerName) {
        eventhub.unregisterBlockEvent(blockRegNum);
        eventhub.disconnect();
        if (config.logdir) {
            blocksLog.write('\n]\n');
            blocksLog.close();
        }
    }

    let min_t = Number.MAX_VALUE;
    let max_t = 0;
    for (const txid in txTable) {
        const tx = txTable[txid];
        const [t1, t2, t3] = tx;
        if (t1 < min_t) {
            min_t = t1;
        }
        if (t2 > max_t) {
            max_t = t2;
        }
        if (t3 !== undefined && t3 > max_t) {
            max_t = t3;
        }
    }

    for (const num in blockTable) {
        const t4 = blockTable[num].timestamp;
        for (const txType in blockTable[num].txset) {
            for (const code in blockTable[num].txset[txType]) {
                for (const txid of blockTable[num].txset[txType][code]) {
                    tx = txTable[txid];
                    if (tx !== undefined) {
                        tx.push(t4);
                        if (t4 > max_t) {
                            max_t = t4;
                        }
                    }
                }
            }
        }
    }

    const period = 5000;

    min_t = roundDown(min_t, period);
    max_t = roundUp(max_t, period);
    const elapsed = max_t - min_t;

    const latencies = [];

    for (let i = 0; i < elapsed / period; i++) {
        latencies.push({
            peer: [],
            orderer: [],
            commit: [],
        });
    }

    const begin = min_t;

    for (const txid in txTable) {
        const tx = txTable[txid];
        const [t1, t2, t3, t4] = tx;
        latencies[roundDown(t2 - begin, period) / period].peer.push(t2 - t1);
        latencies[roundDown(t3 - begin, period) / period].orderer.push(t3 - t2);
        if (t4 !== undefined) {
            latencies[roundDown(t4 - begin, period) / period].commit.push(t4 - t3);
        }
    }

    console.log(' elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg peer.pctl orderer.pctl commit.pctl');
    for (let i = 0; i < elapsed / period; i++) {
        const data = {
            elapsed: i * period / 1000,
            peer: {
                tps: latencies[i].peer.length / period * 1000,
                avg: average(latencies[i].peer),
                pctl: percentile(latencies[i].peer, 0.9)
            },
            orderer: {
                tps: latencies[i].orderer.length / period * 1000,
                avg: average(latencies[i].orderer),
                pctl: percentile(latencies[i].orderer, 0.9)
            },
            commit: {
                tps: latencies[i].commit.length / period * 1000,
                avg: average(latencies[i].commit),
                pctl: percentile(latencies[i].commit, 0.9)
            }
        };
        s = sprintf('%(elapsed)8d %(peer.tps)8.2f %(orderer.tps)11.2f %(commit.tps)10.2f %(peer.avg)8.2f %(orderer.avg)11.2f %(commit.avg)10.2f %(peer.pctl)9.2f %(orderer.pctl)12.2f %(commit.pctl)11.2f', data);
        console.log('%s', s);
    }
}

const handlerTable = {
    'putstate': {
        'genArgs': info => [String(info.num), String(info.size), util.format('key_mychannel_org1_0_%d_%d', info.workerID, info.index)]
    },
    'getstate': {
        'genArgs': info => [String(info.num), String(info.population), util.format('key_mychannel_org1_0_%d_%d', info.workerID, info.index)]
    },
    'mix': {
        'genArgs': info => [String(info.num), String(info.size), util.format('key_mychannel_org1_0_%d_%d', info.workerID, info.index), String(info.population)]
    },
    'json': {
        'genArgs': info => [String(info.num), String(info.size), util.format('key_mychannel_org1_0_%d_%d', info.workerID, info.index), String(info.population)]
    }
}

async function execute(info) {
    const client = info.client;
    const channel = info.channel;
    const txStats = info.txStats;

    const tx_id = client.newTransactionID();

    const request = {
        targets: info.peers,
        chaincodeId: 'ccperf',
        fcn: info.type,
        args: info.genArgs(info),
        txId: tx_id
    };
    if (info.genTransientMap) {
        request.transientMap = info.genTransientMap(info);
    }

    const t1 = new Date();

    const results = await channel.sendTransactionProposal(request);

    const t2 = new Date();

    const proposalResponses = results[0];

    if (proposalResponses.length == 0) {
        console.error('Endorsement failure: Proposal response is empty');
        return;
    }
    if (!proposalResponses.reduce((ok, res) => ok && res.response && res.response.status == 200, true)) {
        const res = proposalResponses.filter(res => !res.response || res.response.status != 200)[0];
        console.error('Endorsement failure: ' + res.message);
        return;
    }

    const proposal = results[1];

    const orderer_request = {
        txId: tx_id,
        proposalResponses: proposalResponses,
        proposal: proposal,
    };

    if (info.orderer) {
        orderer_request.orderer = info.orderer;
    }

    orderer_results = await channel.sendTransaction(orderer_request);

    const t3 = new Date();

    txStats[tx_id.getTransactionID()] = [t1.getTime(), t2.getTime(), t3.getTime()];
    if (info.requestsLog) {
        if (info.index > 0) {
            info.requestsLog.write(',\n');
        }
        info.requestsLog.write(JSON.stringify({ txid: tx_id.getTransactionID(), peer: [{ submission: t1, response: t2 }], orderer: { submission: t2, response: t3 } }, undefined, 4));
    }

    info.index += 1;
}

async function worker(config) {
    const client = await getClient(config.profile, config.orgName);
    let peers;
    if (config.endorsingPeerName) {
        peers = [client.getPeer(endorsingPeerName)];
    }
    const channel = client.getChannel(config.channelID);
    const txStats = {};
    const genArgs = handlerTable[config.type].genArgs;
    const genTransientMap = handlerTable[config.type].genTransientMap;

    let requestsLog;
    if (config.logdir) {
        const requestsLogPath = config.logdir + '/requests-' + cluster.worker.id + '.json';
        requestsLog = fs.createWriteStream(requestsLogPath, { flags: 'wx' });
        requestsLog.write('[\n');
    }

    const info = {
        client: client,
        channel: channel,
        peers: peers,
        txStats: txStats,
        workerID: cluster.worker.id,
        type: config.type,
        num: config.num,
        size: config.size,
        population: config.population,
        index: 0,
        genArgs: genArgs,
        requestsLog: requestsLog
    };

    if (peers) {
        info.peers = peers;
    } else if (config.endorsingOrgs) {
        const orgs = config.endorsingOrgs;
        peers = []
        for (org of orgs) {
            const orgPeers = client.getPeersForOrg(profile.organizations[org].mspid);
            peers.push(orgPeers[info.workerID % orgPeers.length]);
        }
        info.peers = peers;
    }

    if (config.ordererSelection == 'balance') {
        const orderers = channel.getOrderers();
        const orderer = orderers[cluster.worker.id % orderers.length];
        info.orderer = orderer.getName();
    }

    if (genTransientMap) {
        info.genTransientMap = genTransientMap;
    }

    const wait = config.start + config.delay - Date.now();
    if (wait > 0) {
        await sleep(wait);
    }

    //const timeout = setInterval(execute, interval, info);
    //await sleep(duration);
    //clearInterval(timeout);

    const end = Date.now() + config.duration;
    let behind = 0;
    while (true) {
        const before = Date.now();
        execute(info);
        const after = Date.now();
        const remaining = config.interval - (after - before) - behind;
        if (remaining > 0) {
            behind = 0;
            await sleep(remaining);
        } else {
            behind = -remaining;
        }
        if (Date.now() > end) {
            break;
        }
    }

    //console.log(info.index/duration*1000);

    await new Promise(resolve => {
        process.send(txStats, null, {}, resolve);
    });

    if (config.logdir) {
        requestsLog.write('\n]\n');
        requestsLog.close();
    }

    process.exit(0); // Forces to close all connections
}

function sleep(msec) {
    return new Promise(resolve => setTimeout(resolve, msec));
}

function loadConnectionProfile(filePath) {
    const baseDir = path.dirname(filePath);
    const profile = yaml.safeLoad(loadFile(filePath));

    function path2pem(key) {
        if (key !== undefined && key.path !== undefined && key.pem === undefined) {
            const pem = loadFile(key.path, baseDir);
            key.pem = pem;
            delete key.path;
        }
    }

    for (const name of Object.keys(profile.organizations)) {
        const org = profile.organizations[name];
        path2pem(org.signedCert);
        path2pem(org.adminPrivateKey);
    }
    for (const name of Object.keys(profile.orderers)) {
        const orderer = profile.orderers[name];
        path2pem(orderer.tlsCACerts);
    }
    for (const name of Object.keys(profile.peers)) {
        const peer = profile.peers[name];
        path2pem(peer.tlsCACerts);
    }

    return profile;
}

function run(cmd) {
    const profilePath = cmd.profile === undefined ? "./connection-profile.yaml" : cmd.profile;
    const profile = loadConnectionProfile(profilePath);

    const processes = cmd.processes === undefined ? 1 : Number(cmd.processes);
    const target = cmd.target === undefined ? 1 : Number(cmd.target);
    const duration = 1000.0 * cmd.duration;
    const tps = target / processes;
    const interval = 1000.0 / tps
    const rampup = cmd.rampup === undefined ? interval : 1000.0 * Number(cmd.rampup);

    let channelID = cmd.channelID
    if (channelID === undefined) {
        if (profile.channels !== undefined) {
            channelID = Object.keys(profile.channels)[0]
        }
        if (channelID === undefined) {
            throw new Error("No channel is defined in connection profile");
        }
    } else if (profile.channels === undefined || profile.channels[channelID] === undefined) {
        throw new Error(util.format("%s: channel is not defined in connection profile", channelID));
    }
    if (profile.organizations === undefined || Object.keys(profile.organizations).length === 0) {
        throw new Error("No valid organization is defined in connection profile");
    }
    if (profile.channels[channelID].peers === undefined || Object.keys(profile.channels[channelID].peers).length === 0) {
        throw new Error(util.format("No valid peer is defined for %s in connection profile", channelID));
    }
    if (profile.channels[channelID].orderers === undefined || Object.keys(profile.channels[channelID].orderers).length === 0) {
        throw new Error(util.format("No valid orderer is defined for %s in connection profile", channelID));
    }

    const endorsingPeers = Object.entries(profile.channels[channelID].peers).filter(([name, peer]) => peer.endorsingPeer === true).map(([name, peer]) => name);
    let endorsingOrgs = Object.entries(profile.organizations).filter(([name, org]) => org.peers.reduce((flag, peerName) => flag || endorsingPeers.includes(peerName), false)).map(([name, org]) => name);
    if (cmd.endorsingOrgs !== undefined) {
        const orgs = cmd.endorsingOrgs.split(',');
        if (orgs.length == 0 || orgs.filter(name => endorsingOrgs.includes(name)).length < orgs.length) {
            throw new Error("Invalid --endorsingOrgs option");
        }
        endorsingOrgs = orgs;
    }

    let orgName = cmd.org;
    if (orgName === undefined) {
        orgName = endorsingOrgs[0];
    } else if (!endorsingOrgs.includes(orgName)) {
        throw new Error(util.format("%s: not a valid organization for endorsing in %s", orgName, channelID));
    }
    const config = {
        profile: profile,
        channelID: cmd.channelID,
        logdir: cmd.logdir,
        processes: processes,
        target: target,
        orgName: orgName,
        endorsingOrgs: cmd.endorsingOrgs === undefined ? undefined : cmd.endorsingOrgs.split(','),
        peerSelection: cmd.peerSelection,
        ordererSelection: cmd.ordererSelection,
        committingPeerName: cmd.committingPeer,
        type: cmd.type,
        num: cmd.num === undefined ? 1 : Number(cmd.num),
        size: cmd.size === undefined ? 1 : Number(cmd.size),
        population: cmd.population === undefined ? undefined : Number(cmd.population),
        grafana: cmd.grafana,
        duration: duration,
        interval: interval,
        rampup: rampup
    };

    master(config).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

function main() {
    if (!cluster.isMaster) {
        cluster.worker.on('disconnect', () => {
            console.error('Worker %d: Master process prematurely disconnected', cluster.worker.id);
            process.exit(1);
        });

        const promise = new Promise((resolve, reject) => {
            cluster.worker.on('message', msg => {
                if (msg !== undefined && msg.config !== undefined) {
                    resolve(msg.config)
                } else {
                    reject('Worker process receives an unknown mesasge from master process');
                }
            });
        });

        return promise.then(config => {
            return worker(config);
        }).then(() => {
            return cluster.disconnect();
        }).catch(err => {
            console.error('Worker %d: ', cluster.worker.id, err);
            process.exit(1);
        });
    }

    program.command('run')
        .option('--logdir [dir]', "Directory name where log files are stored")
        .option('--processes [number]', "Number of processes to be launched")
        .option('--profile [path]', "Connection profile")
        .option('--channelID [channel]', "Channel name")
        .option('--target [number]', "Target input TPS")
        .option('--rampup [number]', "Rampup in second")
        .option('--duration [number]', "Duration in second")
        .option('--org [string]', "Organization name")
        .option('--type [string]', "Type of workload (eg. putstate)")
        .option('--num [number]', "Number of operations per transaction")
        .option('--size [bytes]', "Payload size of a PutState call")
        .option('--population [number]', "Number of prepopulated key-values")
        .option('--committing-peer [name]', "Peer name whose commit events are monitored ")
        .option('--endorsing-orgs [org1,org2]', 'Comma-separated list of organizations')
        .option('--orderer-selection [type]', "Orderer selection method: first or balance. Default is first")
        .option('--grafana [url]', "Grafana endpoint URL ")
        .action(run);
    program.parse(process.argv);
}

main()
