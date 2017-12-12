/* Copyright 2017 Streampunk Media Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

const httpOut = require('../nodes/40-spm-http-in.js');
const httpIn = require('../nodes/40-spm-http-out.js');
const test = require('tape');
const TestUtil = require('dynamorse-test');

test('Check the modules load OK', t => {
  t.ok(httpOut, 'HTTP out loads OK.');
  t.ok(httpIn, 'HTTP in loads OK.');
  t.end();
});

const httpOutNode = () => ({
  type: 'spm-http-out',
  z: TestUtil.testFlowId,
  name: 'HTTP sender',
  wsPort: TestUtil.properties.wsPort,
  protocol: 'HTTP',
  mode: 'pull',
  pushURL: '',
  path: '/test',
  port: 8712,
  regenerate: false,
  parallel: 1,
  cacheSize: 10,
  fragments: 1,
  timeout: 0,
  backpressure: true,
  x: 300,
  y: 100,
  wires: []
});

const httpInNode = () => ({
  type: 'spm-http-in',
  z: TestUtil.testFlowId,
  name: 'HTTP receiver',
  wsPort: TestUtil.properties.wsPort,
  maxBuffer: 10,
  protocol: 'HTTP',
  mode: 'pull',
  pullURL: 'http://localhost',
  path: '/test',
  port: 8712,
  regenerate: false,
  parallel: 1,
  cacheSize: 10,
  fragments: 1,
  x: 100,
  y: 300,
  wires: [[]]
});

const funnelGrainID = '2e49e0ee.6154b';
const httpSenderID = '9c26da77.ee24e8';
const httpReceiverID = 'b5fc1a27.fd08e8';
const spoutTestID = '235b251e.c1821a';

TestUtil.nodeRedTest('Testing HTTP-out to HTTP-in pull simplest case', {
  numPushes: 10,
  timeout: 40,
  spoutCount: 0
}, params => {
  var testFlow = TestUtil.testNodes.baseTestFlow();
  testFlow.nodes.push(Object.assign(httpInNode(), {
    id: httpReceiverID,
    wires: [ [ spoutTestID ] ]
  }));

  testFlow.nodes.push(Object.assign(TestUtil.testNodes.spoutTestNode(), {
    id: spoutTestID,
    timeout: params.timeout,
    x: 300,
    y: 300
  }));

  testFlow.nodes.push(Object.assign(TestUtil.testNodes.funnelGrainNode(), {
    id: funnelGrainID,
    numPushes: params.numPushes,
    format: 'video',
    delay: 10,
    wires: [ [ httpSenderID ] ]
  }));

  testFlow.nodes.push(Object.assign(httpOutNode(), {
    id: httpSenderID
  }));

  return testFlow;
}, (t, params, msgObj, onEnd) => {
  let msgType = Object.keys(msgObj)
    .reduce((x, y) => x + y + ' ', '')
    .replace(/src /, msgObj.src);
  t.comment(`Message: '${msgType}'`);
  switch (msgType) {
  case 'receive spout':
    TestUtil.checkGrain(t, msgObj.receive);
    break;
  case 'end spout':
    return onEnd();
  default:
    t.comment(`Not handling ${msgType}: ${JSON.stringify(msgObj)}`);
    break;
  }
});
