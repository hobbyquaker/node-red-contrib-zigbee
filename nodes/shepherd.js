const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

const mkdirp = require('mkdirp');
const ZigbeeHerdsman = require('zigbee-herdsman');
const shepherdConverters = require('zigbee-herdsman-converters');
const utils = require('../lib/utils.js');
const reporting = require('../lib/reporting.js');
const toJson = require('../lib/json.js');

const interval = require('../lib/interval.json');

const configured = new Set();
const configuring = new Set();
const shepherdNodes = {};
const herdsmanInstances = {};

const herdsmanPath = path.dirname(require.resolve('zigbee-herdsman'));
const convertersPath = path.dirname(require.resolve('zigbee-herdsman-converters'));

const herdsmanVersion = require(path.join(herdsmanPath, 'package.json')).version;
const convertersVersion = require(path.join(convertersPath, 'package.json')).version;

const zclDefinitions = require(path.join(herdsmanPath, 'dist/zcl/definition/index.js'));

module.exports = function (RED) {
    RED.httpAdmin.get('/zigbee-shepherd/status', RED.auth.needsPermission('zigbee.read'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            res.status(200).send(shepherdNodes[req.query.id].joinPermitted ? 'join permitted' : (shepherdNodes[req.query.id].status || ''));
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/devices', RED.auth.needsPermission('zigbee.read'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            const devices = shepherdNodes[req.query.id].herdsman.getDevices().map(d => toJson.deviceToJson(d));
            res.status(200).send(JSON.stringify(devices));
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/groups', RED.auth.needsPermission('zigbee.read'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            const groups = shepherdNodes[req.query.id].herdsman.getGroups().map(g => toJson.groupToJson(g));
            res.status(200).send(JSON.stringify(groups));
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/createGroup', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].createGroup(req.body.groupID, req.body.name).then(result => {
                res.status(200).send(JSON.stringify(result));
            }).catch(err => {
                res.status(500).send(err && err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/removeGroup', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].removeGroup(req.body.groupID).then(result => {
                res.status(200).send(JSON.stringify(result));
            }).catch(err => {
                res.status(500).send(err && err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/bind', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            let promise;
            if (req.body.type === 'endpoint') {
                promise = shepherdNodes[req.query.id].bind(req.body.device, req.body.endpoint, req.body.cluster, req.body.targetDevice, req.body.targetEndpoint);
            } else {
                promise = shepherdNodes[req.query.id].bindGroup(req.body.device, req.body.endpoint, req.body.cluster, req.body.group);
            }

            promise.then(result => {
                res.status(200).send(JSON.stringify(result));
            }).catch(err => {
                res.status(500).send(err && err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/unbind', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            let promise;
            if (req.body.type === 'endpoint') {
                promise = shepherdNodes[req.query.id].unbind(req.body.device, req.body.endpoint, req.body.cluster, req.body.targetDevice, req.body.targetEndpoint);
            } else {
                promise = shepherdNodes[req.query.id].unbindGroup(req.body.device, req.body.endpoint, req.body.cluster, req.body.targetDevice);
            }

            promise.then(result => {
                res.status(200).send(JSON.stringify(result));
            }).catch(err => {
                res.status(500).send(err && err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/addGroupMember', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].addGroupMember(req.body.groupID, req.body.ieeeAddr, req.body.endpoint).then(result => {
                res.status(200).send(JSON.stringify(result));
            }).catch(err => {
                res.status(500).send(err && err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/removeFromGroup', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].removeFromGroup(req.body.groupID, req.body.ieeeAddr, req.body.epID).then(result => {
                res.status(200).send(JSON.stringify(result));
            }).catch(err => {
                res.status(500).send(err && err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/definitions', RED.auth.needsPermission('zigbee.read'), (req, res) => {
        res.status(200).send(JSON.stringify(zclDefinitions));
    });

    RED.httpAdmin.get('/zigbee-shepherd/scan', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            if (shepherdNodes[req.query.id]) {
                shepherdNodes[req.query.id].shepherd.lqiScan(shepherdNodes[req.query.id].shepherd.controller._coord.ieeeAddr)
                    .then(topology => {
                        res.status(200).json(topology);
                    })
                    .catch(err => {
                        res.status(500).send('500 Internal Server Error: ' + err.message);
                    });
            } else {
                res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
            }
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/getRoutingTable', RED.auth.needsPermission('zigbee.read'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].getRoutingTable(req.query.ieeeAddr).then(result => {
                res.status(200).json(result);
            }).catch(err => {
                res.status(500).send(err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/getLqi', RED.auth.needsPermission('zigbee.read'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].getLqi(req.query.ieeeAddr).then(result => {
                res.status(200).json(result);
            }).catch(err => {
                res.status(500).send(err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/vis/*', (req, res) => {
        const file = (req.params[0] || '').split('?')[0];
        const root = path.dirname(require.resolve('vis'));
        fs.access(path.join(root, file), fs.constants.F_OK, err => {
            if (err) {
                res.status(404).send('Error 404: file not found');
            } else {
                res.sendFile(file, {
                    root,
                    dotfiles: 'deny'
                });
            }
        });
    });

    RED.httpAdmin.get('/zigbee-shepherd/map/*', (req, res) => {
        const file = (req.params[0] || '').split('?')[0] || 'index.html';
        const root = path.join(__dirname, '../static/map');
        fs.access(path.join(root, file), fs.constants.F_OK, err => {
            if (err) {
                res.status(404).send('Error 404: file not found');
            } else {
                res.sendFile(file, {
                    root,
                    dotfiles: 'deny'
                });
            }
        });
    });

    RED.httpAdmin.post('/zigbee-shepherd/rename', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].rename(req.body);
            res.status(200).send('');
        } else {
            res.status(404).send('shepherd id ' + req.query.id + ' not found');
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/report', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].report(req.body.ieeeAddr, req.body.shouldReport);
            res.status(200).send('');
        } else {
            res.status(404).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/joinPermitted', RED.auth.needsPermission('zigbee.read'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            res.status(200).send({permit: shepherdNodes[req.query.id].joinPermitted});
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/remove', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].remove(req.query.ieeeAddr).then(() => {
                res.status(200).send('');
            }).catch(err => {
                res.status(500).send(err && err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/join', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].permitJoin(req.query.permit === 'true');
            res.status(200).send('');
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.get('/zigbee-shepherd/soft-reset', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].softReset();
            res.status(200).send('');
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/cmd', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            const cmd = JSON.parse(req.body.cmd);
            const {cmdType} = cmd;
            let promise;
            switch (cmdType) {
                case 'command':
                    promise = shepherdNodes[req.query.id].command(cmd.ieeeAddr, cmd.ep, cmd.cid, cmd.cmd, cmd.payload /*, cmd.options */);
                    break;
                case 'read':
                    promise = shepherdNodes[req.query.id].read(cmd.ieeeAddr, cmd.ep, cmd.cid, cmd.attributes /*, cmd.options */);
                    break;
                case 'write':
                    promise = shepherdNodes[req.query.id].write(cmd.ieeeAddr, cmd.ep, cmd.cid, cmd.attributes /*, cmd.options */);
                    break;
                default:
            }

            promise.then(result => {
                res.status(200).send(result || {});
            }).catch(err => {
                res.status(500).send(err.message);
            });

            //shepherdNodes[req.query.id].proxy.queue(cmd);
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/groupcmd', RED.auth.needsPermission('zigbee.write'), (req, res) => {
        if (shepherdNodes[req.query.id]) {
            const cmd = JSON.parse(req.body.cmd);
            shepherdNodes[req.query.id].groupCommand(cmd.groupID, cmd.cid, cmd.cmd, cmd.payload).then(result => {
                res.status(200).send(result || {});
            }).catch(err => {
                res.status(500).send(err.message);
            });
        } else {
            res.status(500).send(`500 Internal Server Error: Unknown Herdsman ID ${req.query.id}`);
        }
    });

    class HerdsmanProxy extends EventEmitter {
        constructor(shepherdNode) {
            super();

            this.setMaxListeners(1000);

            this.shepherdNode = shepherdNode;
            this.shepherd = shepherdNode.shepherd;
            this.devices = shepherdNode.devices;
            this.logName = shepherdNode.logName;

            this.trace = msg => {
                shepherdNode.trace(msg);
            };

            this.debug = msg => {
                shepherdNode.debug(msg);
            };

            this.log = msg => {
                shepherdNode.log(msg);
            };

            this.warn = msg => {
                shepherdNode.warn(msg);
            };

            this.error = msg => {
                shepherdNode.error(msg);
            };
        }
    }

    class ZigbeeShepherd {
        constructor(config) {
            RED.nodes.createNode(this, config);

            this.persistPath = path.join(RED.settings.userDir, 'zigbee', this.id);

            this.log('Herdsman   version: v' + herdsmanVersion);
            this.log('Converters version: v' + convertersVersion);
            this.log('persistPath ' + this.persistPath);
            if (!fs.existsSync(this.persistPath)) {
                this.log('mkdirp ' + this.persistPath);
                mkdirp.sync(this.persistPath);
            }

            this.startTime = (new Date()).getTime();

            this.namesPath = path.join(this.persistPath, 'names.json');
            this.dbPath = path.join(this.persistPath, 'dev.db');
            this.backupPath = path.join(this.persistPath, 'backup.db');
            this.led = config.led;

            try {
                this.names = require(this.namesPath);
            } catch (_) {
                this.names = {};
            }

            shepherdNodes[this.id] = this;

            let precfgkey;
            if (this.credentials.precfgkey) {
                const bytes = this.credentials.precfgkey.match(/[0-9a-fA-F]{2}/gi);
                precfgkey = bytes.map(t => parseInt(t, 16));
            }

            let panID = 0xFFFF;
            if (this.credentials.panId) {
                panID = parseInt(this.credentials.panId, 16);
            }

            this.herdsmanOptions = {
                serialPort: {
                    path: config.path,
                    baudRate: parseInt(config.baudRate, 10) || 115200,
                    rtscts: Boolean(config.rtscts)
                },
                network: {
                    panID,
                    networkKey: precfgkey,
                    channelList: config.channelList
                },
                databasePath: this.dbPath,
                backupPath: this.backupPath
            };

            this.reportingConfiguring = new Set();
            this.offlineTimeouts = {};

            const listeners = {
                deviceAnnounce: data => {
                    this.log(`deviceAnnounce ${data.device.ieeeAddr} ${data.device.meta.name || ''}`);
                    if (data.device.interviewCompleted) {
                        this.reachable(data.device, true);
                        this.configure(data.device);
                        this.proxy.emit('devices');
                    }
                },
                deviceLeave: data => {
                    this.log(`deviceLeave ${data.ieeeAddr}`);
                    this.proxy.emit('devices');
                },
                adapterDisconnected: data => {
                    this.status = 'adapterDisconnected';
                    this.proxy.emit('nodeStatus', {fill: 'red', shape: 'ring', text: 'adapterDisconnected'});
                    this.error('adapterDisconnected ' + data);
                },
                deviceJoined: data => {
                    this.log(`deviceJoined ${data.device.ieeeAddr}`);
                },
                deviceInterview: data => {
                    if (data.status === 'successful') {
                        this.log(`deviceInterview successful ${data.device.ieeeAddr} ${data.device.manufacturerName} ${data.device.modelID}`);
                        this.reachable(data.device, true);
                        this.proxy.emit('devices');
                        this.configure(data.device);
                    } else {
                        this.log(`deviceInterview ${data.status} ${data.device.ieeeAddr}`);
                    }
                },
                message: message => {
                    this.messageHandler(message);
                }
            };

            if (!herdsmanInstances[this.id]) {
                this.debug('creating new herdsman instance');
                herdsmanInstances[this.id] = new ZigbeeHerdsman.Controller(this.herdsmanOptions);
            }

            this.herdsman = herdsmanInstances[this.id];

            this.proxy = new HerdsmanProxy(this);

            this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'starting'});
            this.status = 'starting';
            this.log('connecting ' + config.path + ' ' + JSON.stringify(this.herdsmanOptions.sp));
            this.herdsman.start().then(() => {
                this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'connecting'});
                this.logStartupInfo();

                Object.keys(listeners).forEach(event => {
                    this.herdsman.addListener(event, listeners[event]);
                    this.debug(`add ${event} listener`);
                });

                const devices = this.herdsman.getDevices();
                this.log(`Currently ${devices.length - 1} devices are joined:`);
                devices.forEach(device => {
                    if (device.type === 'Coordinator') {
                        this.coordinatorEndpoint = device.endpoints[0];
                        device.meta.name = 'Coordinator';
                        device.meta.isCoordinator = true;
                        return;
                    }

                    delete device.meta.offline;
                    this.log(`${device.ieeeAddr} ${device.meta.name} (${device.type} ${device.manufacturerName} ${device.modelID})`);
                    if (this.names[device.ieeeAddr] && typeof device.meta.name === 'undefined') {
                        this.rename({ieeeAddr: device.ieeeAddr, name: this.names[device.ieeeAddr].name});
                    }
                });
                // TODO remove obsolete names.json file
                this.proxy.emit('ready');
                this.status = 'connected';
                this.proxy.emit('nodeStatus', {fill: 'green', shape: 'dot', text: 'connected'});
                this.herdsman.setLED(this.led === 'enabled');

                this.checkOverdueInterval = setInterval(() => {
                    this.checkOverdue();
                }, 60000);

                devices.forEach(device => {
                    if (device.type === 'Router') {
                        this.configure(device);
                    }
                });
            }).catch(error => {
                this.status = error.message;
                this.proxy.emit('nodeStatus', {fill: 'red', shape: 'ring', text: error.message + ', retrying'});
                this.error(error.message);
            });

            this.on('close', done => {
                this.debug('stopping');
                clearInterval(this.checkOverdueInterval);
                this.status = 'closing';
                this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'ring', text: 'closing'});

                Object.keys(listeners).forEach(event => {
                    this.herdsman.removeListener(event, listeners[event]);
                    this.debug(`removed ${event} listener`);
                });
                this.herdsman.stop().then(() => {
                    this.debug('stopped shepherd');
                }).catch(err => {
                    this.error(`stop ${err.message}`);
                }).finally(() => {
                    this.status = '';
                    this.proxy.emit('nodeStatus', {});
                    setTimeout(() => {
                        this.proxy.removeAllListeners();
                        this.debug('removed proxy event listeners');
                        done();
                    }, 100);
                });
            });
        }

        logStartupInfo() {
            this.herdsman.getNetworkParameters().then(data => {
                this.log(`Zigbee network parameters: ${JSON.stringify(data)}`);
            }).then(() => {
                this.herdsman.getCoordinatorVersion().then(data => {
                    const version = `${data.meta.majorrel}.${data.meta.minorrel}.${data.meta.maintrel}`;
                    const {revision} = data.meta;
                    const {type} = data;
                    this.log(`Coordinator: ${type} ${version} ${revision}`);
                    const coordinator = this.coordinatorEndpoint.getDevice();
                    coordinator.meta.version = version;
                    coordinator.meta.revision = revision;
                    coordinator.meta.type = type;
                });
            });
        }

        createGroup(groupID, name) {
            return new Promise((resolve, reject) => {
                if (this.herdsman.getGroupByID(groupID)) {
                    reject(new Error(`Group ${groupID} already exists`));
                    return;
                }

                const group = this.herdsman.createGroup(groupID);
                group.meta.name = name || ('group' + groupID);
                group.save();
                resolve(group);
            });
        }

        removeGroup(groupID) {
            return new Promise((resolve, reject) => {
                const group = this.herdsman.getGroupByID(groupID);
                if (group) {
                    if (group.members.size === 0) {
                        group.removeFromDatabase();
                        this.log('group removeFromDatabase ' + groupID);
                        resolve();
                    } else {
                        this.error(`removeGroup group ${groupID} not empty`);
                        reject(new Error(`removeGroup group ${groupID} not empty`));
                    }
                } else {
                    this.error(`removeGroup unknown group ${groupID}`);
                    reject(new Error(`removeGroup unknown group ${groupID}`));
                }
            });
        }

        addGroupMember(groupID, ieeeAddr, epID) {
            return new Promise((resolve, reject) => {
                const group = this.herdsman.getGroupByID(parseInt(groupID, 10));
                if (!group) {
                    reject(new Error(`unknown group ${groupID}`));
                    return;
                }

                this.herdsman.getDeviceByIeeeAddr(ieeeAddr).getEndpoint(epID).addToGroup(group).then(result => {
                    this.log(`addGroupMember ${groupID} ${ieeeAddr} ${epID} successful`);
                    resolve(result);
                }).catch(error => {
                    this.error(error.message);
                    reject(error);
                });
            });
        }

        removeFromGroup(groupID, ieeeAddr, epID) {
            //console.log('removeFromGroup', groupID, ieeeAddr, epID, typeof epID);
            return new Promise((resolve, reject) => {
                const group = this.herdsman.getGroupByID(parseInt(groupID, 10));
                this.herdsman.getDeviceByIeeeAddr(ieeeAddr).endpoints.find(ep => ep.ID === epID).removeFromGroup(group).then(result => {
                    this.log(`removeFromGroup ${groupID} ${ieeeAddr} ${epID} successful`);
                    resolve(result);
                }).catch(error => {
                    this.error(error.message);
                    reject(error);
                });
            });
        }

        command(ieeeAddr, endpoint, cluster, command, payload, options) {
            return new Promise((resolve, reject) => {
                const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
                if (!device) {
                    reject(new Error(`Device ${ieeeAddr} not found`));
                    return;
                }

                const ep = device.getEndpoint(endpoint);
                if (!ep) {
                    reject(new Error(`Endpoint ${endpoint} of ${ieeeAddr} ${device.meta.name} not found`));
                    return;
                }

                if (ep) {
                    ep.command(cluster, command, payload, options).then(result => {
                        this.debug(`command successful ${ieeeAddr} ${device.meta.name} ${endpoint} ${cluster} ${command} ${JSON.stringify(payload)} ${Object.keys(options || {}).length > 0 ? JSON.stringify(options) : ''}`);
                        this.reachable(this.herdsman.getDeviceByIeeeAddr(ieeeAddr), true);
                        clearTimeout(this.offlineTimeouts[ieeeAddr]);
                        this.offlineTimeouts[ieeeAddr] = setTimeout(() => {
                            delete this.offlineTimeouts[ieeeAddr];
                        });
                        resolve(result);
                    }).catch(err => {
                        this.debug(`command failed ${ieeeAddr} ${device.meta.name} ${endpoint} ${cluster} ${command} ${err.message}`);
                        if (!this.offlineTimeouts[ieeeAddr]) {
                            this.reachable(this.herdsman.getDeviceByIeeeAddr(ieeeAddr), false);
                        }

                        reject(err);
                    });
                } else {
                    reject(new Error('Endpoint not found'));
                }
            });
        }

        groupCommand(groupID, cluster, command, payload) {
            return new Promise((resolve, reject) => {
                const group = this.herdsman.getGroupByID(groupID);
                if (!group) {
                    reject(new Error(`Group ${groupID} not found`));
                    return;
                }

                group.command(cluster, command, payload).then(result => {
                    this.debug(`group command successful ${groupID} ${group.meta.name} ${cluster} ${command} ${JSON.stringify(payload)}`);
                    resolve(result);
                }).catch(err => {
                    this.debug(`group command failed ${groupID} ${group.meta.name} ${cluster} ${command} ${err.message}`);
                    reject(err);
                });
            });
        }

        read(ieeeAddr, endpoint, cluster, payload, options) {
            return new Promise((resolve, reject) => {
                this.log(`read ${ieeeAddr} ${endpoint} ${cluster} ${JSON.stringify(payload)} ${JSON.stringify(options)}`);
                const ep = this.herdsman.getDeviceByIeeeAddr(ieeeAddr).getEndpoint(endpoint);
                if (ep) {
                    ep.read(cluster, payload, options).then(result => {
                        this.reachable(this.herdsman.getDeviceByIeeeAddr(ieeeAddr), true);
                        resolve(result);
                    }).catch(err => {
                        this.reachable(this.herdsman.getDeviceByIeeeAddr(ieeeAddr), false);
                        reject(err);
                    });
                } else {
                    reject(new Error('Endpoint not found'));
                }
            });
        }

        write(ieeeAddr, endpoint, cluster, attributes, options) {
            return new Promise((resolve, reject) => {
                this.log(`write ${ieeeAddr} ${endpoint} ${cluster} ${JSON.stringify(attributes)} ${JSON.stringify(options)}`);
                const ep = this.herdsman.getDeviceByIeeeAddr(ieeeAddr).getEndpoint(endpoint);
                if (ep) {
                    ep.write(cluster, attributes, options).then(result => {
                        this.reachable(this.herdsman.getDeviceByIeeeAddr(ieeeAddr), true);
                        resolve(result);
                    }).catch(err => {
                        this.reachable(this.herdsman.getDeviceByIeeeAddr(ieeeAddr), false);
                        reject(err);
                    });
                } else {
                    reject(new Error('Endpoint not found'));
                }
            });
        }

        reachable(device, state) {
            const offline = !state;
            if (device.meta.hue && device.meta.hue.state.reachable !== state) {
                device.meta.hue.state.reachable = state;
            }

            if (device.meta.offline !== offline) {
                device.meta.offline = offline;
                this.proxy.emit('offline', device);
            }
        }

        rename(data) {
            if (data.ieeeAddr) {
                const device = this.herdsman.getDeviceByIeeeAddr(data.ieeeAddr);
                if (device) {
                    device.meta.name = data.name;
                    this.debug(`renamed ${data.ieeeAddr} to "${data.name}"`);
                    device.save();
                }
            } else {
                const group = this.herdsman.getGroupByID(data.data.groupID);
                if (group) {
                    group.meta.name = data.name;
                    this.debug(`renamed group ${data.groupID} to "${data.name}"`);
                    group.save();
                }
            }
        }

        report(ieeeAddr, shouldReport) {
            const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
            if (device) {
                device.meta.shouldReport = shouldReport;
                device.save();
                this.configureReport(device);
            }
        }

        configureReport(device) {
            return new Promise(resolve => {
                if (device.meta.shouldReport && (!device.meta.reporting || utils.isIkeaTradfriDevice(device))) {
                    reporting.setup.call(this, device).finally(resolve);
                } else if (!device.meta.shouldReport && device.meta.reporting) {
                    reporting.remove.call(this, device).finally(resolve);
                }
            });
        }

        bind(ieeeAddr, epid, cluster, targetIeeeAddr, targetEpid) {
            return new Promise((resolve, reject) => {
                const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
                const endpoint = device.getEndpoint(epid);

                const targetDevice = this.herdsman.getDeviceByIeeeAddr(targetIeeeAddr);
                if (!targetDevice) {
                    reject(new Error(`cannot find device ${targetIeeeAddr}`));
                    return;
                }

                const targetEndpoint = targetDevice.getEndpoint(targetEpid);
                if (!targetEndpoint) {
                    reject(new Error(`cannot find endpoint ${targetEpid} of device ${targetIeeeAddr} ${targetDevice.meta.name}`));
                    return;
                }

                endpoint.bind(cluster, targetEndpoint).then(() => {
                    this.log(`bind ${device.ieeeAddr} ${device.meta.name} ${epid} ${cluster} to ${targetDevice.ieeeAddr} ${targetDevice.meta.name} ${targetEpid} successful`);
                    resolve();
                }).catch(error => {
                    this.error(`bind ${device.ieeeAddr} ${device.meta.name} ${epid} ${cluster} to ${targetDevice.ieeeAddr} ${targetDevice.meta.name} ${targetEpid} error`);
                    this.error(error.message);
                    reject(error);
                });
            });
        }

        bindGroup(ieeeAddr, epid, cluster, groupID) {
            return new Promise((resolve, reject) => {
                const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
                const endpoint = device.getEndpoint(epid);
                const group = this.herdsman.getGroupByID(groupID);

                if (!group) {
                    reject(new Error(`cannot find group ${groupID}`));
                    return;
                }

                endpoint.bind(cluster, group).then(() => {
                    this.log(`bind ${device.ieeeAddr} ${device.meta.name} ${epid} ${cluster} to group ${groupID} ${group.meta.name} successful`);
                    resolve();
                }).catch(error => {
                    this.error(`bind ${device.ieeeAddr} ${device.meta.name} ${epid} ${cluster} to group ${groupID} ${group.meta.name} error`);
                    this.error(error.message);
                    reject(error);
                });
            });
        }

        unbind(ieeeAddr, epid, cluster, targetIeeeAddr, targetEpid) {
            return new Promise((resolve, reject) => {
                const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
                const endpoint = device.getEndpoint(epid);

                const targetDevice = this.herdsman.getDeviceByIeeeAddr(targetIeeeAddr);
                const targetEndpoint = targetDevice.getEndpoint(targetEpid);

                endpoint.unbind(cluster, targetEndpoint).then(() => {
                    this.log(`unbind ${device.ieeeAddr} ${device.meta.name} ${epid} ${cluster} from ${targetDevice.ieeeAddr} ${targetDevice.meta.name} ${targetEpid} successful`);
                    resolve();
                }).catch(error => {
                    this.error(`unbind ${device.ieeeAddr} ${device.meta.name} ${epid} ${cluster} from ${targetDevice.ieeeAddr} ${targetDevice.meta.name} ${targetEpid} error`);
                    this.error(error.message);
                    reject(error);
                });
            });
        }

        unbindGroup(ieeeAddr, epid, cluster, groupID) {
            return new Promise((resolve, reject) => {
                const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
                const endpoint = device.getEndpoint(epid);

                const targetGroup = this.herdsman.getGroupByID(groupID);

                endpoint.unbind(cluster, targetGroup).then(() => {
                    this.log(`unbind ${device.ieeeAddr} ${device.meta.name} ${epid} ${cluster} from group ${groupID} ${targetGroup.meta.name} successful`);
                    resolve();
                }).catch(error => {
                    this.error(`unbind ${device.ieeeAddr} ${device.meta.name} ${epid} ${cluster} from group ${groupID} ${targetGroup.meta.name} error`);
                    this.error(error.message);
                    reject(error);
                });
            });
        }

        softReset() {
            this.herdsman.softReset().then(() => {
                this.log('soft-reset z-stack');
            });
        }

        configure(dev) {
            const doConfigure = device => {
                if (!device || device.type === 'Coordinator' || configured.has(device.ieeeAddr) || configuring.has(device.ieeeAddr)) {
                    return;
                }

                const mappedDevice = shepherdConverters.findByZigbeeModel(device.modelID);
                if (mappedDevice && mappedDevice.configure) {
                    this.debug(`configure ${device.ieeeAddr} ${device.meta.name}`);
                    configuring.add(device.ieeeAddr);
                    mappedDevice.configure(device, this.coordinatorEndpoint).then(() => {
                        this.log(`successfully configured ${this.logName(device)}`);
                        configured.add(device.ieeeAddr);
                    }).catch(err => {
                        this.warn(`configure failed ${this.logName(device)} ${err && err.message}`);
                    }).finally(() => {
                        configuring.delete(device.ieeeAddr);
                        this.configureReport(device);
                    });
                } else {
                    this.configureReport(device);
                }
            };

            if (dev) {
                const device = this.herdsman.getDeviceByIeeeAddr(dev.ieeeAddr);
                doConfigure(device);
            } else {
                this.herdsman.getDevices().forEach(device => {
                    doConfigure(device);
                });
            }
        }

        messageHandler(message) {
            this.debug('message ' + message.type + ' ' + this.logName(message.device));
            this.proxy.emit('message', message);
            clearTimeout(this.offlineTimeouts[message.device.ieeeAddr]);
            this.offlineTimeouts[message.device.ieeeAddr] = setTimeout(() => {
                delete this.offlineTimeouts[message.device.ieeeAddr];
            });
            this.reachable(message.device, true);
            if (message.device.interviewCompleted) {
                this.configure(message.device);
            }
        }

        remove(ieeeAddr) {
            return new Promise((resolve, reject) => {
                this.log('remove ' + ieeeAddr);
                const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
                device.removeFromNetwork().then(() => {
                    this.log('removed from network ' + ieeeAddr + ' ' + device.meta.name);
                }).catch(err => {
                    this.error((err && err.message) + ' ' + ieeeAddr);
                    device.removeFromDatabase().then(() => {
                        this.log('removed from database ' + ieeeAddr + ' ' + device.meta.name);
                        resolve();
                    }).catch(err => {
                        this.error((err && err.message) + ' ' + ieeeAddr);
                        reject(err);
                    });
                });
            });
        }

        permitJoin(permit) {
            this.log('permitJoin ' + permit);
            this.herdsman.permitJoin(permit);
            this.joinPermitted = permit;
            this.proxy.emit('permitJoin', permit);
        }

        checkOverdue() {
            const now = (new Date()).getTime();
            this.herdsman.getDevices().forEach(device => {
                const timeout = interval[device.modelID];
                if (timeout) {
                    const elapsed = Math.round(((now - (device.lastSeen || this.startTime)) / 60000));
                    const reachable = elapsed < timeout;
                    //this.debug(`checkOverdue ${device.ieeeAddr} ${device.meta.name} elapsed=${elapsed} timeout=${timeout}`);
                    if (device.lastSeen || !reachable) {
                        this.reachable(device, reachable);
                    }
                }
            });
        }

        logName(device) {
            return device.meta.name ? `${device.ieeeAddr} (${device.meta.name})` : `${device.ieeeAddr}`;
        }

        getLqi(ieeeAddr) {
            return new Promise((resolve, reject) => {
                const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
                if (!device) {
                    reject(new Error('unknown device ' + ieeeAddr));
                    return;
                }

                this.debug(`get lqi ${this.logName(device)}`);
                device.lqi().then(result => {
                    this.debug(`lqi ${this.logName(device)} has ${result.neighbors.length} neighbors`);
                    resolve(result.neighbors);
                }).catch(err => {
                    this.error(err.message);
                    reject(err);
                });
            });
        }

        getRoutingTable(ieeeAddr) {
            return new Promise((resolve, reject) => {
                const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
                if (!device) {
                    reject(new Error('unknown device ' + ieeeAddr));
                    return;
                }

                this.debug(`get routingTable ${this.logName(device)}`);
                device.routingTable().then(result => {
                    this.debug(`routingTable ${this.logName(device)} has ${result.table.length} routes`);
                    resolve(result.table);
                }).catch(err => {
                    this.error(err.message);
                    reject(err);
                });
            });
        }
    }

    RED.nodes.registerType('zigbee-shepherd', ZigbeeShepherd, {
        credentials: {
            panId: {type: 'text'},
            precfgkey: {type: 'text'}
        }
    });
};
