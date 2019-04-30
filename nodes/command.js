module.exports = function (RED) {
    class ZigbeeCommand {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            let nodeStatus;
            shepherdNode.proxy.on('nodeStatus', status => {
                nodeStatus = status;
                this.status(status);
            });

            this.shepherd = shepherdNode.shepherd;

            this.on('input', msg => {

                const cmdType = msg.cmdType || config.cmdType;
                const ieeeAddr = msg.ieeeAddr || ((config.ieeeAddr || '').split(' ')[0]);
                const ep = msg.ep || config.ep;
                const destination = msg.destination || config.destination;
                const dstIeeeAddr = msg.dstIeeeAddr || config.dstIeeeAddr;
                const dstEp = msg.dstEp || config.dstEp;
                const dstGroup = msg.dstGroup || config.dstGroup;
                const cid = msg.cid || config.cid;
                const cmd = msg.cmd || config.cmd;
                const data = msg.data || config.data;
                const zclData = msg.zclData || config.zclData;
                const attrId = msg.attrId || config.attrId;
                const minInt = msg.minInt || config.minInt;
                const maxInt = msg.maxInt || config.maxInt;
                const repChange = msg.repChange || config.repChange;
                const manufSpec = msg.manufSpec || config.manufSpec;
                const disableDefaultRsp = msg.disableDefaultRsp || config.disableDefaultRsp;

                let obj;

                switch (cmdType) {
                    case 'functional':
                    case 'foundation':
                        obj = {
                            cmdType,
                            ieeeAddr,
                            ep,
                            cid,
                            cmd,
                            zclData,
                            cfg: {
                                manufSpec,
                                disableDefaultRsp
                            }
                        };
                        break;
                    case 'write':
                        obj = {
                            cmdType,
                            ieeeAddr,
                            ep,
                            cid,
                            data
                        };
                        break;
                    case 'read':
                        obj = {
                            cmdType,
                            ieeeAddr,
                            ep,
                            cid
                        };
                        break;
                    case 'bind':
                    case 'unbind':
                        obj = {
                            cmdType,
                            ieeeAddr,
                            ep,
                            cid,
                            destination,
                            dstIeeeAddr,
                            dstEp,
                            dstGroup
                        };
                        break;
                    case 'report':
                        obj = {
                            cmdType,
                            ieeeAddr,
                            ep,
                            cid,
                            attrId,
                            minInt,
                            maxInt
                        };
                        if (repChange) {
                            obj.repChange = repChange;
                        }
                        break;
                    default:
                        this.error('unknown command ' + cmdType);
                }

                obj.callback = (err, res) => {
                    if (err) {
                        this.error(err);
                        this.status({fill: 'red', shape: 'dot', text: err});
                    } else {
                        this.send({topic: msg.topic, payload: res});
                        this.status(nodeStatus);
                    }
                };

                shepherdNode.proxy.queue(obj);
            });
        }
    }

    RED.nodes.registerType('zigbee-command', ZigbeeCommand);
};
