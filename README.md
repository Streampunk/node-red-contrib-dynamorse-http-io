[![CircleCI](https://circleci.com/gh/Streampunk/node-red-contrib-dynamorse-http-io.svg?style=shield&circle-token=:circle-token)](https://circleci.com/gh/Streampunk/node-red-contrib-dynamorse-http-io)
[![Coverage Status](https://coveralls.io/repos/github/Streampunk/node-red-contrib-dynamorse-http-io/badge.svg?branch=master)](https://coveralls.io/github/Streampunk/node-red-contrib-dynamorse-http-io?branch=master)
# node-red-contrib-dynamorse-http-io

A set of nodes for IBM's [Node-RED](http://nodered.org) that support http input/output for grains, an implementation of the draft [arachnid](https://github.com/Streampunk/arachnid) protocol. This package is a component of Streampunk Media's [dynamorse](https://github.com/Streampunk/node-red-contrib-dynamorse-core#readme) suite.

Features include:

* parallel transport of the elementary streams that make up a _logical cable_ using the _cable-in_ and _cable-out_ nodes, allowing video, audio and associated streams to be transported in tandem;
* push and pull modes - choose how you cross a fire wall;
* HTTP and HTTPS;
* transport of grains in parallel, with up to 6 concurrent threads;
* distributing back pressure across the transport.

Currently not implemented is the splitting of grains into fragments.

## Installation

First follow the installation instructions for [dynamorse-core](https://github.com/Streampunk/node-red-contrib-dynamorse-core#readme).

This package can be installed from the 'manage palette' option in the Node-RED menu. Alternatively in your Node-RED user directory, typically ~/.node-red, run

    npm install node-red-contrib-dynamorse-http-io

## Status, support and further development

Contributions can be made via pull requests and will be considered by the author on their merits. Enhancement requests and bug reports should be raised as github issues. For support, please contact [Streampunk Media](http://www.streampunk.media/).

## License

This software is released under the Apache 2.0 license. Copyright 2018 Streampunk Media Ltd.
