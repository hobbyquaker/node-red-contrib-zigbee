# node-red-contrib-zigbee

[![NPM version](https://badge.fury.io/js/node-red-contrib-zigbee.svg)](http://badge.fury.io/js/node-red-contrib-zigbee)
[![Dependencies Status](https://david-dm.org/hobbyquaker/node-red-contrib-zigbee/status.svg)](https://david-dm.org/hobbyquaker/node-red-contrib-zigbee)
[![Build Status](https://travis-ci.org/hobbyquaker/node-red-contrib-zigbee.svg?branch=master)](https://travis-ci.org/hobbyquaker/node-red-contrib-zigbee)
[![XO code style](https://img.shields.io/badge/code_style-XO-5ed9c7.svg)](https://github.com/sindresorhus/xo)
[![License][mit-badge]][mit-url]

> Control Zigbee Devices (Xiaomi Aqara, Hue, Lightify, Tradfri, ...) with Node-RED via a CC253x Module. No need for
proprietary bridges anymore, use devices of different vendors in one Zigbee network.

**Work in progress** Will bump version to 1.0 as soon as todo is done, zigbee-herdsman api is stable and everything is 
tested.

## Credits

Based on [zigbee-herdsman](https://github.com/Koenkk/zigbee-herdsman), Koenkk's fork of 
[Zigbee Shepherd](https://github.com/zigbeer/zigbee-shepherd). Strongly inspired by his awesome
[zigbee2mqtt](https://github.com/Koenkk/zigbee2mqtt) project. 

## Hardware Prerequisites

see https://www.zigbee2mqtt.io/getting_started/what_do_i_need.html
Ready to use firmware images are available here: https://github.com/Koenkk/Z-Stack-firmware/tree/master/coordinator

## Getting started

Add any Zigbee Node, open it's configuration, add a "herdsman" node, configure it, close both nodes and deploy. Wait
a few seconds and go to the configuration of the "herdsman" node again, now you should be able to pair devices. Keep
an eye on Node-RED's log output.


## Nodes

#### herdman

Config node that holds the serial port and ZigBee network configuration of zigbee-herdsman. You should change the 
`networkKey` for security reasons before pairing the first devices. I suggest to use a password manager (like e.g. KeyPass) 
to create and store a random key (has to be 16 Byte in uppercase hex representation (32 chars 0-9A-F). 
With this config node you can also manage your devices (pairing, removing, renaming), reporting, groups and binds.


#### converter

This Node utilizes [Koenkk's zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-shepherd-converters) and 
offers payload formats as known from zigbee2mqtt. In fact most of this nodes code is taken 1:1 from zigbee2mqtt.


#### hue

This node aims to be a drop-in replacement for https://github.com/hobbyquaker/hue2mqtt.js


#### offline

This node outputs the online/offline status of the devices.


#### event

This Node outputs events as received from zigbee-herdsman. 


#### command

Send a command to a device endpoint or group. 


#### controller

Call methods of the herdsman controller


## Todo

* [x] Converter node: readAfterWrite
* [ ] Hue node: readAfterWrite
* [x] Converter node: Determine endpoint
* [x] Converter node: Group support 
* [x] Converter node: Get command
* [x] Hue node: Group support
* [x] Command node: Group support
* [x] Group bind support
* [x] remove frontend debug output
* [x] per-device configurable ping
* [x] per-device configurable configure
* [x] Secure shepherd node REST API, use Authentication
* [ ] Documentation
* [x] Adapt to Node-RED 1.0 message API
* [ ] OTA Update

## License

MIT (c) Sebastian Raff

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
