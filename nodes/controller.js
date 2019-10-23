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

            this.on('input', msg => {
                switch (msg.topic) {
                    case 'permitJoin':
                        herdsmanNode.permitJoin(Boolean(msg.payload));
                        break;
                    case 'getPermitJoin':
                        this.send({topic: msg.topic, payload: this.herdsman.getPermitJoin()});
                        break;
                    case 'reset':
                        this.herdsman.reset(String(msg.payload).toLowerCase() === 'hard' ? 'hard' : 'soft').then(result => {
                            this.send({topic: msg.topic, payload: result});
                        });
                        break;
                    case 'getCoordinatorVersion':
                        this.herdsman.getCoordinatorVersion().then(result => {
                            this.send({topic: msg.topic, payload: result});
                        });
                        break;
                    case 'getNetworkParameters':
                        this.herdsman.getNetworkParameters().then(result => {
                            this.send({topic: msg.topic, payload: result});
                        });
                        break;
                    case 'getDevices':
                        this.send({topic: msg.topic, payload: this.herdsman.getDevices()});
                        break;
                    case 'getGroups':
                        this.send({topic: msg.topic, payload: this.herdsman.getGroups()});
                        break;
                    case 'enableLED':
                        this.herdsman.enableLED();
                        break;
                    case 'disableLED':
                        this.herdsman.disableLED();
                        break;
                    default:
                        this.error(`Unknown command ${msg.payload}`);
                }
            });
        }
    }

    RED.nodes.registerType('zigbee-controller', ZigbeeController);
};
