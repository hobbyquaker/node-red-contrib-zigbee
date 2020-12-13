module.exports = function (RED) {
    class ZigbeeCommand {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            let nodeStatus = {text: ''};

            this.shepherd = shepherdNode.herdsman;

            let configZclData;
            try {
                if (typeof configZclData !== 'object') {
                    configZclData = JSON.parse(config.zclData);
                }
            } catch {
                configZclData = {};
            }

            let configAttributesRead;
            try {
                configAttributesRead = JSON.parse(config.attributesRead);
            } catch {
                configAttributesRead = {};
            }

            let configAttributesWrite;
            try {
                configAttributesWrite = JSON.parse(config.attributesWrite);
            } catch {
                configAttributesWrite = {};
            }

            this.on('input', (msg, send, done) => {
                const cmdType = msg.cmdType || config.cmdType;
                const target = msg.target || config.target;
                const ieeeAddr = msg.ieeeAddr || ((config.ieeeAddr || '').split(' ')[0]);
                const group = msg.group || ((config.group || '').split(' ')[0]);
                const ep = Number.parseInt(msg.endpoint || msg.ep || config.ep, 10);
                const cid = msg.cluster || msg.cid || config.cid;
                const cmd = msg.command || msg.cmd || config.cmd;
                const zclData = msg.payload || msg.parameters || msg.zclData || configZclData;
                const attributesRead = msg.attributes || configAttributesRead;
                const attributesWrite = msg.attributes || configAttributesWrite;
                //const manufSpec = msg.manufSpec || config.manufSpec;
                //const disableDefaultRsp = msg.disableDefaultRsp || config.disableDefaultRsp;
                let promise;
                switch (cmdType) {
                    case 'command':
                        promise = target === 'endpoint' ? shepherdNode.command(ieeeAddr, ep, cid, cmd, zclData) : shepherdNode.groupCommand(group, cid, cmd, zclData);

                        break;
                    case 'write':
                        promise = shepherdNode.write(ieeeAddr, ep, cid, attributesWrite);
                        break;
                    case 'read':
                        promise = shepherdNode.read(ieeeAddr, ep, cid, attributesRead);
                        break;
                    default:
                        this.error('unknown command ' + cmdType);
                }

                promise.then(result => {
                    if (send) {
                        send({topic: msg.topic, payload: result});
                    } else {
                        this.send({topic: msg.topic, payload: result});
                    }

                    if (done) {
                        done();
                    }

                    this.status(nodeStatus);
                }).catch(err => {
                    if (done) {
                        done(err);
                    } else {
                        this.error(err.message);
                    }

                    this.status({fill: 'red', shape: 'dot', text: err.message});
                });
            });

            const nodeStatusHandler = status => {
                nodeStatus = status;
                this.status(status);
            };

            this.debug('adding event listeners');
            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);

            this.on('close', () => {
                this.debug('removing event listeners');
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
            });
        }
    }

    RED.nodes.registerType('zigbee-command', ZigbeeCommand);
};
