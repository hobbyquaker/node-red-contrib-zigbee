module.exports = function (RED) {
    class ZigbeeController {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const herdsmanNode = RED.nodes.getNode(config.shepherd);

            if (!herdsmanNode) {
                this.error('missing herdsman');
                return;
            }

            let nodeStatus = {text: ''};
            herdsmanNode.proxy.on('nodeStatus', status => {
                nodeStatus = status;
                this.status(status);
            });
            herdsmanNode.proxy.on('permitJoin', status => {
                if (status) {
                    this.status({shape: 'ring', fill: 'blue', text: 'join permitted'});
                } else {
                    this.status(nodeStatus);
                }
            });

            this.herdsman = herdsmanNode.herdsman;

            this.on('input', (msg, send, done) => {
                send = send || this.send.bind(this);

                if (!done) {
                    done = err => {
                        if (err) {
                            this.error(err.message);
                        }
                    };
                }

                switch (msg.topic) {
                    case 'permitJoin':
                        herdsmanNode.permitJoin(Boolean(msg.payload));
                        done();
                        break;
                    case 'getPermitJoin':
                        send({topic: msg.topic, payload: this.herdsman.getPermitJoin()});
                        done();
                        break;
                    case 'reset':
                        this.herdsman.reset(String(msg.payload).toLowerCase() === 'hard' ? 'hard' : 'soft').then(result => {
                            send({topic: msg.topic, payload: result});
                            done();
                        });
                        break;
                    case 'getCoordinatorVersion':
                        this.herdsman.getCoordinatorVersion().then(result => {
                            send({topic: msg.topic, payload: result});
                            done();
                        });
                        break;
                    case 'getNetworkParameters':
                        this.herdsman.getNetworkParameters().then(result => {
                            send({topic: msg.topic, payload: result});
                            done();
                        });
                        break;
                    case 'getDevices':
                        send({topic: msg.topic, payload: this.herdsman.getDevices()});
                        done();
                        break;
                    case 'getGroups':
                        send({topic: msg.topic, payload: this.herdsman.getGroups()});
                        done();
                        break;
                    case 'setLED':
                        this.herdsman.setLED(Boolean(msg.payload)).then(() => {
                            done();
                        });
                        break;
                    default:
                        done(new Error(`Unknown command ${msg.payload}`));
                }
            });
        }
    }

    RED.nodes.registerType('zigbee-controller', ZigbeeController);
};
