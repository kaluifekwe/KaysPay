import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

const sampleRate=22050;
const duration=120;
const samples=sampleRate*duration;
const data=Buffer.alloc(samples*2);
const chords=[[130.81,164.81,196],[110,138.59,164.81],[98,123.47,146.83],[116.54,146.83,174.61]];

for(let i=0;i<samples;i++){
  const t=i/sampleRate;
  const chord=chords[Math.floor(t/8)%chords.length];
  const fade=Math.min(1,t/3,(duration-t)/5);
  const pad=chord.reduce((sum,f,index)=>sum+Math.sin(2*Math.PI*f*t+(index*.7))*.12,0);
  const shimmer=Math.sin(2*Math.PI*(chord[1]*2)*t)*.035*(.5+.5*Math.sin(2*Math.PI*t/8));
  const beatPhase=t%1.5;
  const beat=Math.sin(2*Math.PI*65*t)*Math.exp(-beatPhase*7)*.18;
  const sample=Math.max(-1,Math.min(1,(pad+shimmer+beat)*fade));
  data.writeInt16LE(Math.round(sample*32767),i*2);
}

const header=Buffer.alloc(44);
header.write('RIFF',0); header.writeUInt32LE(36+data.length,4); header.write('WAVE',8);
header.write('fmt ',12); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20);
header.writeUInt16LE(1,22); header.writeUInt32LE(sampleRate,24); header.writeUInt32LE(sampleRate*2,28);
header.writeUInt16LE(2,32); header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(data.length,40);
const output=resolve('public/audio/kayspay-ambient.wav'); mkdirSync(dirname(output),{recursive:true}); writeFileSync(output,Buffer.concat([header,data]));
console.log(output);
