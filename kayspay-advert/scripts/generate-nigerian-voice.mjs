import {mkdirSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import edgeTts from 'msedge-tts';
const {MsEdgeTTS,OUTPUT_FORMAT}=edgeTts;

const voice='en-NG-EzinneNeural';
const output=resolve('public/audio/voice-ng-action');
mkdirSync(output,{recursive:true});

const scenes=[
  ['01-intro.mp3','Your everyday services should be simple. Open Kay’sPay and bring payments, connectivity, crypto, eSIM, and NIN services together in one convenient app.'],
  ['02-airtime-data.mp3','Need airtime or data now? Open Kay’sPay, choose your network, enter the phone number, select an amount, and confirm. Stay connected without unnecessary stress.'],
  ['03-bills.mp3','Ready to settle a bill? Choose electricity or television, enter the correct account details, review everything carefully, then confirm your payment in a few clear steps.'],
  ['04-crypto.mp3','Want to explore supported crypto services? Open the Crypto section, review the available options and applicable terms, then choose the service that works for you.'],
  ['05-esim.mp3','Travelling soon? Open eSIM, check your destination and device compatibility, compare available plans, and select the connection that suits your journey.'],
  ['06-nin.mp3','Need supported NIN assistance? Open the NIN section, choose the service you need, follow the instructions, and submit only accurate identity information.'],
  ['07-trust.mp3','Take control with clear navigation and helpful feedback. Review your details before every confirmation, protect your PIN, and contact support whenever you need help.'],
  ['08-outro.mp3','Airtime, data, bills, crypto, eSIM and NIN, all in one app. Download Kay’sPay, create your account, and start today. Pay smarter. Live easier.'],
];

for(const [file,text] of scenes){
  const tts=new MsEdgeTTS();
  await tts.setMetadata(voice,OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const {audioFilePath}=await tts.toFile(output,text,{rate:'+7%',pitch:'-2Hz',volume:'+5%'});
  renameSync(audioFilePath,resolve(output,file));
  tts.close();
  console.log(file);
}
