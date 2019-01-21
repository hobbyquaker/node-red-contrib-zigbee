const path = require('path');
const Shepherd = require('zigbee-shepherd');

module.exports = function (RED) {
    class ZigbeeShepherd {
        constructor(config) {
            RED.nodes.createNode(this, config);

            let precfgkey;
            if (this.credentials.precfgkey) {
                const bytes = this.credentials.precfgkey.match(/[0-9a-fA-F]{2}/gi);
                precfgkey = bytes.map(t => parseInt(t, 16));
            }

            let panId = 0xFFFF;
            if (this.credentials.panId) {
                panId = parseInt(this.credentials.panId, 16);
            }

            const shepherdOptions = {
                sp: {
                    baudRate: parseInt(config.baudRate, 10) || 115200,
                    rtscts: Boolean(config.rtscts)
                },
                net: {
                    panId,
                    precfgkey,
                    channelList: config.channelList
                },
                dbPath: path.join(RED.settings.userDir, 'zigbee', this.id, 'dev.db')
            };

            this.shepherd = new Shepherd(config.path, shepherdOptions);

            this.shepherd.on('ready', () => {
                this.debug('ready');
            });

            this.shepherd.on('error', error => {
                this.error(error);
            });

            this.shepherd.start(error => {
                if (error) {
                    this.error(error);
                }
            });

            this.on('close', done => {
                this.debug('stop shepherd');
                this.shepherd.stop(() => {
                    this.shepherd.removeAllListeners();
                    done();
                });
            });
        }
    }

    RED.nodes.registerType("zigbee-shepherd", ZigbeeShepherd, {
        credentials: {
            panId: {type: 'text'},
            precfgkey: {type: 'text'}
        }
    });
};
