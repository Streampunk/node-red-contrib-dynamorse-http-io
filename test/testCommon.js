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

const TestUtil = require('dynamorse-test');

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

var httpGraph = params => {
  var testFlow = TestUtil.testNodes.baseTestFlow();
  testFlow.nodes.push(Object.assign(httpInNode(), {
    id: httpReceiverID,
    parallel: params.parallel,
    protocol: params.protocol === 'HTTPS'? 'HTTPS' : 'HTTP',
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
    format: params.format,
    delay: 10,
    wires: [ [ httpSenderID ] ]
  }));

  testFlow.nodes.push(Object.assign(httpOutNode(), {
    id: httpSenderID,
    parallel: params.parallel,
    protocol: params.protocol === 'HTTPS'? 'HTTPS' : 'HTTP'
  }));

  return testFlow;
};

var recvMsg = function (t, params, msgObj, onEnd) {
  let msgType = Object.keys(msgObj)
    .reduce((x, y) => x + y + ' ', '')
    .replace(/src /, msgObj.src);
  // t.comment(`Message: '${msgType}'`);
  switch (msgType) {
  case 'push funnel':
    params.seqTest.push(msgObj.push);
    break;
  case 'receive spout':
    TestUtil.checkGrain(t, msgObj.receive);
    t.deepEqual(msgObj.receive, params.seqTest[params.spoutCount++],
      `funnel and spout objects for index ${params.spoutCount} are the same for ${msgObj.receive.ptpOriginTimestamp}.`);
    break;
  case 'found srcID srcType HTTP sender':
    // t.comment(`*** FOUND sender *** ${JSON.stringify(msgObj.found)}.`);
    params.sentTags = msgObj.found[0];
    break;
  case 'found srcID srcType spout':
    t.deepEqual(msgObj.found[0], params.sentTags,
      'cable descriptions at sender and spout match.');
    break;
  case 'end spout':
    t.equal(params.spoutCount, params.numPushes,
      `number of receives at spout is ${params.spoutCount}.`);
    return setTimeout(onEnd, 1000);
  default:
    t.comment(`Not handling ${msgType}: ${JSON.stringify(msgObj)}`);
    break;
  }
};

module.exports = {
  httpOutNode: httpOutNode,
  httpInNode: httpInNode,
  funnelGrainID: funnelGrainID,
  httpSenderID: httpSenderID,
  httpReceiverID: httpReceiverID,
  spoutTestID: spoutTestID,
  httpGraph: httpGraph,
  recvMsg: recvMsg
};
