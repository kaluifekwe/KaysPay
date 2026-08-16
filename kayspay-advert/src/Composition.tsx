import {Audio} from '@remotion/media';
import {TransitionSeries,linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {AbsoluteFill,Sequence,interpolate,staticFile,useCurrentFrame} from 'remotion';
import {IntroScene} from './scenes/IntroScene';import {EverydayScene} from './scenes/EverydayScene';import {BillsScene} from './scenes/BillsScene';import {CryptoScene} from './scenes/CryptoScene';import {EsimScene} from './scenes/EsimScene';import {NinScene} from './scenes/NinScene';import {TrustScene} from './scenes/TrustScene';import {OutroScene} from './scenes/OutroScene';

const transition=linearTiming({durationInFrames:15});
const Voice:React.FC<{from:number;file:string}>=({from,file})=><Sequence from={from} layout="none"><Audio src={staticFile(`audio/voice-ng-action/${file}`)} volume={1}/></Sequence>;

const AudioMix:React.FC=()=> <>
  <Audio src={staticFile('audio/kayspay-ambient.wav')} volume={(frame)=>interpolate(frame,[0,90,3450,3599],[0,.12,.12,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}/>
  <Voice from={30} file="01-intro.mp3"/><Voice from={465} file="02-airtime-data.mp3"/><Voice from={900} file="03-bills.mp3"/><Voice from={1335} file="04-crypto.mp3"/>
  <Voice from={1770} file="05-esim.mp3"/><Voice from={2205} file="06-nin.mp3"/><Voice from={2640} file="07-trust.mp3"/><Voice from={3045} file="08-outro.mp3"/>
</>;

const BeatGlow:React.FC=()=>{const frame=useCurrentFrame();return <div style={{position:'absolute',inset:-120,pointerEvents:'none',border:`${8+Math.sin(frame/7)*4}px solid #70E59D`,borderRadius:160,opacity:.035+Math.max(0,Math.sin(frame/7))*.035,boxShadow:'inset 0 0 120px #2E7D5255'}}/>};

export const KaysPayAdvert:React.FC=()=> <AbsoluteFill>
  <TransitionSeries>
    <TransitionSeries.Sequence durationInFrames={450} name="Opening"><IntroScene/></TransitionSeries.Sequence><TransitionSeries.Transition presentation={fade()} timing={transition}/>
    <TransitionSeries.Sequence durationInFrames={450} name="Airtime and data"><EverydayScene/></TransitionSeries.Sequence><TransitionSeries.Transition presentation={slide({direction:'from-right'})} timing={transition}/>
    <TransitionSeries.Sequence durationInFrames={450} name="Bills"><BillsScene/></TransitionSeries.Sequence><TransitionSeries.Transition presentation={fade()} timing={transition}/>
    <TransitionSeries.Sequence durationInFrames={450} name="Crypto"><CryptoScene/></TransitionSeries.Sequence><TransitionSeries.Transition presentation={slide({direction:'from-bottom'})} timing={transition}/>
    <TransitionSeries.Sequence durationInFrames={450} name="eSIM"><EsimScene/></TransitionSeries.Sequence><TransitionSeries.Transition presentation={fade()} timing={transition}/>
    <TransitionSeries.Sequence durationInFrames={450} name="NIN"><NinScene/></TransitionSeries.Sequence><TransitionSeries.Transition presentation={slide({direction:'from-left'})} timing={transition}/>
    <TransitionSeries.Sequence durationInFrames={450} name="Trust"><TrustScene/></TransitionSeries.Sequence><TransitionSeries.Transition presentation={fade()} timing={transition}/>
    <TransitionSeries.Sequence durationInFrames={555} name="Call to action"><OutroScene/></TransitionSeries.Sequence>
  </TransitionSeries>
  <BeatGlow/><AudioMix/>
</AbsoluteFill>;
