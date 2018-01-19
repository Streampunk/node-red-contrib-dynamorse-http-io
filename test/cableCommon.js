/* Copyright 2018 Streampunk Media Ltd.

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

const cableOutNode = () => ({
  type: 'cable-out',
  z: TestUtil.testFlowId,
  name: 'cable sender',
  wsPort: TestUtil.properties.wsPort,
  protocol: 'HTTP',
  mode: 'pull',
  pushURL: 'http://localhost',
  path: '/test',
  port: 8712,
  regenerate: false,
  parallel: 1,
  cacheSize: 10,
  fragments: 1,
  timeout: 0,
  backpressure: true,
  logTime: true,
  x: 300,
  y: 100,
  wires: []
});

const cableInNode = () => ({
  type: 'cable-in',
  z: TestUtil.testFlowId,
  name: 'cable receiver',
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

const spliceNode = () => ({
  type: 'splice',
  z: TestUtil.testFlowId,
  name: 'splicer',
  maxBuffer: 10,
  x: 200,
  y: 200,
  wires: []
});

const funnelGrainVideoID = '2e49e0ee.6154b';
const funnelGrainAudioID = '23316a2f.127016';
const spliceID = '676d6678.a25658';
const cableSenderID = '64982754.29abd8';
const cableReceiverID = 'f28223e6.33d99';
const spoutTestID = '235b251e.c1821a';

var cableGraph = params => {
  let testFlow = TestUtil.testNodes.baseTestFlow();
  testFlow.nodes.push(Object.assign(cableInNode(), {
    id: cableReceiverID,
    parallel: params.parallel,
    protocol: params.protocol === 'HTTPS' ? 'HTTPS' : 'HTTP',
    mode: params.mode === 'push' ? 'push' : 'pull',
    wires: [ [ spoutTestID ] ]
  }));

  testFlow.nodes.push(Object.assign(TestUtil.testNodes.spoutTestNode(), {
    id: spoutTestID,
    timeout: params.timeout,
    x: 300,
    y: 300
  }));

  testFlow.nodes.push(Object.assign(TestUtil.testNodes.funnelGrainNode(), {
    id: funnelGrainVideoID,
    numPushes: params.numPushes,
    name: 'video funnel',
    format: 'video',
    delay: 10,
    wires: [ [ spliceID ] ]
  }));

  testFlow.nodes.push(Object.assign(TestUtil.testNodes.funnelGrainNode(), {
    id: funnelGrainAudioID,
    numPushes: params.numPushes,
    name: 'audio funnel',
    format: 'audio',
    y: 240,
    wires: [ [ spliceID ]]
  }));

  testFlow.nodes.push(Object.assign(spliceNode(), {
    id: spliceID,
    x: 260,
    y: 180,
    wires: [ [ cableSenderID ] ]
  }));

  testFlow.nodes.push(Object.assign(cableOutNode(), {
    id: cableSenderID,
    x: 450,
    parallel: params.parallel,
    protocol: params.protocol === 'HTTPS' ? 'HTTPS' : 'HTTP',
    mode: params.mode === 'push' ? 'push' : 'pull'
  }));

  return testFlow;
};

var recvMsg = function (t, params, msgObj, onEnd) {
  let msgType = Object.keys(msgObj)
    .reduce((x, y) => x + y + ' ', '')
    .replace(/src /, msgObj.src);
  // t.comment(`Message: '${msgType}'`);
  switch (msgType) {
  case 'push splicer':
    if (!params.seqTest[msgObj.push.flow_id]) {
      params.seqTest[msgObj.push.flow_id] = [];
      params.spoutCount[msgObj.push.flow_id] = 0;
    }
    params.seqTest[msgObj.push.flow_id].push(msgObj.push);
    console.log('>>>', Object.keys(params.seqTest).map(k =>
      params.seqTest[k].map(x => x.ptpOriginTimestamp)));
    break;
  case 'receive spout':
    TestUtil.checkGrain(t, msgObj.receive);
    console.log('<<<', msgObj.receive.flow_id, msgObj.receive.ptpOriginTimestamp);
    t.deepEqual(msgObj.receive,
      params.seqTest[msgObj.receive.flow_id][params.spoutCount[msgObj.receive.flow_id]++],
      `funnel and spout objects for index ${params.spoutCount[msgObj.receive.flow_id]} are the same for ${msgObj.receive.ptpOriginTimestamp}.`);
    break;
  case 'found srcID srcType cable sender':
    // t.comment(`*** FOUND sender *** ${JSON.stringify(msgObj.found)}.`);
    params.sentTags = msgObj.found[0];
    break;
  case 'found srcID srcType spout':
    delete msgObj.found[0].id; // TODO should IDs be the same
    delete params.sentTags.id;
    t.deepEqual(msgObj.found[0], params.sentTags,
      'cable descriptions at sender and spout match.');
    break;
  case 'end spout':
    Object.keys(params.spoutCount).forEach(k => {
      t.equal(params.spoutCount[k], params.numPushes,
        `number of receives at spout is for flow ${k} is ${params.spoutCount[k]}.`);
    });
    return setTimeout(onEnd, 1000);
  default:
    t.comment(`Not handling ${msgType}: ${JSON.stringify(msgObj)}`);
    break;
  }
};

module.exports = {
  cableOutNode: cableOutNode,
  cableInNode: cableInNode,
  funnelGrainVideoID: funnelGrainVideoID,
  funnelGrainAudioID: funnelGrainAudioID,
  cableSenderID: cableSenderID,
  cableReceiverID: cableReceiverID,
  spoutTestID: spoutTestID,
  cableGraph: cableGraph,
  recvMsg: recvMsg
};
