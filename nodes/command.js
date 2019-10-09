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
            shepherdNode.proxy.on('nodeStatus', status => {
                nodeStatus = status;
                this.status(status);
            });

            this.shepherd = shepherdNode.herdsman;

            let configZclData;
            try {
                if (typeof configZclData !== 'object') {
                    configZclData = JSON.parse(config.zclData);
                }
            } catch (_) {
                configZclData = {};
            }

            let configAttributesRead;
            try {
                configAttributesRead = JSON.parse(config.configAttributesRead);
            } catch (_) {
                configAttributesRead = {};
            }

            let configAttributesWrite;
            try {
                configAttributesWrite = JSON.parse(config.configAttributesWrite);
            } catch (_) {
                configAttributesWrite = {};
            }

            this.on('input', msg => {
                const cmdType = msg.cmdType || config.cmdType;
                const target = msg.target || config.target;
                const ieeeAddr = msg.ieeeAddr || ((config.ieeeAddr || '').split(' ')[0]);
                const group = msg.group || ((config.group || '').split(' ')[0]);
                const ep = parseInt(msg.endpoint || msg.ep || config.ep, 10);
                const cid = msg.cluster || msg.cid || config.cid;
                const cmd = msg.command || msg.cmd || config.cmd;
                const zclData = msg.parameters || msg.zclData || configZclData;
                const attributesRead = msg.attributes || configAttributesRead;
                const attributesWrite = msg.attributes || configAttributesWrite;
                //const manufSpec = msg.manufSpec || config.manufSpec;
                //const disableDefaultRsp = msg.disableDefaultRsp || config.disableDefaultRsp;

                let promise;
                switch (cmdType) {
                    case 'command':
                        if (target === 'endpoint') {
                            promise = shepherdNode.command(ieeeAddr, ep, cid, cmd, zclData);
                        } else {
                            promise = shepherdNode.groupCommand(group, cid, cmd, zclData);
                        }

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
                    this.send({topic: msg.topic, payload: result});
                    this.status(nodeStatus);
                }).catch(err => {
                    this.error(err.message);
                    this.status({fill: 'red', shape: 'dot', text: err.message});
                });
            });
        }
    }

    RED.nodes.registerType('zigbee-command', ZigbeeCommand);
};
