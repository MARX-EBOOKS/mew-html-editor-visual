import {readFile} from 'node:fs/promises';
const f=JSON.parse(await readFile('tmp/me05-284-live.json','utf8'));console.log(f.targets?.map(t=>({raw:t.raw,connections:t.connections}))); console.log('SOURCE',f.source);
