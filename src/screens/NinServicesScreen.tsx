import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Text,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';
import { formatNaira } from '../utils/formatCurrency';
import { ninService, NinRecord, BvnRecord, NinModificationType } from '../services/nin.service';
import { useTransactionAuth } from '../components/TransactionAuthProvider';
import { sharePdf, downloadPdf } from '../utils/pdf';

const DISCLAIMER = 'This is a reprint of verified NIN details for convenience and is not a replacement for the official NIMC card.';

export type SlipTier = 'regular' | 'standard' | 'premium';

export const SLIP_TIERS: { id: SlipTier; name: string; valueKobo: number }[] = [
  { id: 'regular', name: 'Regular Slip', valueKobo: 35000 },
  { id: 'standard', name: 'Standard Slip', valueKobo: 40000 },
  { id: 'premium', name: 'Premium Slip', valueKobo: 45000 },
];

export type BvnSlipTier = 'slip' | 'card';

export const BVN_SLIP_TIERS: { id: BvnSlipTier; name: string; valueKobo: number }[] = [
  { id: 'slip', name: 'BVN Slip', valueKobo: 35000 },
  { id: 'card', name: 'BVN Card', valueKobo: 45000 },
];

function photoTag(photo?: string, className = 'photo'): string {
  if (!photo) return `<div class="${className} photo-blank"></div>`;
  const src = photo.startsWith('data:') ? photo : `data:image/jpeg;base64,${photo}`;
  return `<img src="${src}" class="${className}" />`;
}

// Nigeria's coat of arms — sourced from Wikimedia Commons
// (https://commons.wikimedia.org/wiki/File:Coat_of_arms_of_Nigeria.svg,
// CC-BY-SA 3.0, public national emblem) per owner's explicit request
// 2026-07-06 to match CheckMyNINBVN's reference slip design exactly. Bundled
// as a rasterized PNG (src/assets/coat-of-arms-nigeria-320.png) since the
// original vector is too large (500KB+) to inline as source text.
const EMBLEM_ASSET = require('../assets/coat-of-arms-nigeria-320.png');

let cachedEmblemBase64: string | null = null;

// Resolves the bundled emblem to a base64 data URI for use inside
// expo-print's HTML string (which can't reference RN require()'d assets
// directly). Cached after the first call — the asset never changes at runtime.
async function getEmblemBase64(): Promise<string> {
  if (cachedEmblemBase64) return cachedEmblemBase64;
  const asset = Asset.fromModule(EMBLEM_ASSET);
  await asset.downloadAsync();
  const base64 = await new File(asset.localUri || asset.uri).base64();
  cachedEmblemBase64 = `data:image/png;base64,${base64}`;
  return cachedEmblemBase64;
}

function emblemTag(base64: string, className: string, size = 48): string {
  return `<img src="${base64}" class="${className}" style="width:${size}px;height:${size}px;object-fit:contain;" />`;
}

function qrTag(nin: string, size = 90): string {
  const data = encodeURIComponent(nin || '');
  return `<img class="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${data}" />`;
}

// Renders a YYYY-MM-DD (or already-loose) date of birth as "01 OCT 1960" to
// match the reference design's display format.
function formatDobDisplay(dob?: string): string {
  if (!dob) return 'N/A';
  const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dob;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return dob;
  return `${m[3]} ${months[monthIndex]} ${m[1]}`;
}

// Regular Slip — the classic tabular NIMC-style layout (Tracking ID, field
// table, footer contact bar).
function buildRegularSlipHtml(record: NinRecord, fullName: string, nin: string, emblemBase64: string): string {
  const [firstname, ...rest] = (fullName || '').split(' ');
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <style>
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 24px; color: #111; background: #f4f4ee; }
    .slip { max-width: 620px; margin: 0 auto; background: #f7f7f0; border: 1px solid #ddd; border-radius: 10px; padding: 20px 24px; }
    .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #1a5c3a; padding-bottom: 10px; margin-bottom: 14px; }
    .header-titles { text-align: center; flex: 1; }
    .header-titles h1 { font-size: 17px; margin: 0; color: #111; }
    .header-titles h2 { font-size: 12px; margin: 2px 0 0; color: #444; font-weight: 500; }
    .header-titles h3 { font-size: 11px; margin: 4px 0 0; color: #1a5c3a; font-weight: 700; letter-spacing: 0.5px; }
    .body-row { display: flex; }
    .fields { flex: 1; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 5px 4px; font-size: 11.5px; vertical-align: top; }
    td.label { color: #666; width: 90px; }
    td.value { font-weight: 700; color: #111; }
    .nin-value { border: 2px solid #c0392b; border-radius: 4px; padding: 1px 6px; display: inline-block; }
    .photo { width: 90px; height: 100px; object-fit: cover; border: 1px solid #999; margin-left: 16px; }
    .photo-blank { background: #ddd; }
    .note { font-size: 9.5px; color: #444; margin-top: 8px; border-top: 1px solid #ccc; padding-top: 6px; }
    .disclaimer { margin-top: 14px; font-size: 9px; color: #999; font-style: italic; text-align: center; }
  </style></head>
  <body>
    <div class="slip">
      <div class="header">
        ${emblemTag(emblemBase64, 'emblem', 44)}
        <div class="header-titles">
          <h1>National Identity Management System</h1>
          <h2>Federal Republic of Nigeria</h2>
          <h3>National Identification Number Slip (NINS)</h3>
        </div>
        <div style="width:44px"></div>
      </div>
      <div class="body-row">
        <div class="fields">
          <table>
            <tr><td class="label">Tracking ID</td><td class="value">${record.trackingId || 'N/A'}</td><td class="label">Surname</td><td class="value">${record.surname || ''}</td></tr>
            <tr><td class="label">NIN</td><td class="value"><span class="nin-value">${record.nin || nin}</span></td><td class="label">First Name</td><td class="value">${firstname || ''}</td></tr>
            <tr><td class="label">Issue Date</td><td class="value">${new Date().toLocaleDateString('en-GB')}</td><td class="label">Middle Name</td><td class="value">${record.middlename || rest.join(' ')}</td></tr>
            <tr><td class="label"></td><td class="value"></td><td class="label">Gender</td><td class="value">${(record.gender || '').toUpperCase()}</td></tr>
          </table>
        </div>
        ${photoTag(record.photo)}
      </div>
      <div class="note">
        <strong>Address:</strong> ${record.residence_address || 'N/A'}, ${record.residence_town || ''} ${record.residence_state || ''}<br/>
        Note: This transaction slip does not confer the right to the General Multipurpose Card.
      </div>
      <div class="disclaimer">${DISCLAIMER}</div>
    </div>
  </body></html>`;
}

// Standard Slip — the modern ID-card-style layout with QR code + watermark.
function buildStandardSlipHtml(record: NinRecord, fullName: string, nin: string, premium: boolean, emblemBase64: string): string {
  const [firstname, ...rest] = (fullName || '').split(' ');
  const givenNames = `${firstname || ''} ${record.middlename || rest.join(' ')}`.trim();
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <style>
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 32px; color: #111; }
    .card { position: relative; width: 540px; margin: 0 auto; border: 1px solid #cfe3d6; border-radius: 10px;
            padding: 20px 24px; background: #f4faf6; overflow: hidden; }
    .bg-pattern { position: absolute; inset: 0; background-image: repeating-linear-gradient(135deg, rgba(26,92,58,0.05) 0px, rgba(26,92,58,0.05) 1px, transparent 1px, transparent 6px); }
    .watermark { position: absolute; opacity: 0.14; left: 50%; top: 48%; transform: translate(-50%, -50%); }
    .header-row { display: flex; justify-content: space-between; align-items: flex-start; position: relative; margin-bottom: 14px; }
    .brand-fed { font-size: 15px; font-weight: 800; color: #1a5c3a; line-height: 1.3; }
    .brand-sub { font-size: 12px; font-weight: 800; color: #16281f; letter-spacing: 0.5px; }
    .qr { width: 92px; height: 92px; }
    .content-row { display: flex; position: relative; }
    .photo { width: 92px; height: 108px; object-fit: cover; border: 1px solid #9db9a8; }
    .photo-blank { background: #cfd8d2; }
    .fields { margin-left: 16px; flex: 1; }
    .field-label { font-size: 9px; color: #6b7d72; text-transform: uppercase; margin-top: 8px; letter-spacing: 0.4px; }
    .field-value { font-size: 15px; font-weight: 700; font-family: 'Courier New', monospace; color: #14231a; }
    .dob-sex-row { display: flex; gap: 28px; }
    .right-col { text-align: right; margin-left: 12px; min-width: 84px; }
    .nga { font-size: 22px; font-weight: 800; letter-spacing: 1px; color: #111; margin-top: 10px; }
    .issue-label { font-size: 8.5px; color: #6b7d72; margin-top: 12px; }
    .issue-value { font-size: 10px; font-weight: 700; color: #14231a; }
    .nin-row { text-align: center; margin-top: 20px; position: relative; }
    .nin-label { font-size: 10px; color: #16281f; font-weight: 800; letter-spacing: 0.6px; text-transform: uppercase; }
    .nin-digits { font-size: 28px; font-weight: 800; letter-spacing: 8px; margin-top: 4px; font-family: 'Courier New', monospace; color: #0d1a12; }
    .disclaimer { max-width: 540px; margin: 12px auto 0; font-size: 9px; color: #999; font-style: italic; text-align: center; }
  </style></head>
  <body>
    <div class="card">
      <div class="bg-pattern"></div>
      ${emblemTag(emblemBase64, 'watermark', 300)}
      <div class="header-row">
        <div>
          ${premium ? '<div class="brand-fed">FEDERAL REPUBLIC OF NIGERIA</div>' : ''}
          <div class="brand-sub">DIGITAL NIN SLIP</div>
        </div>
        ${qrTag(record.nin || nin, 92)}
      </div>
      <div class="content-row">
        ${photoTag(record.photo)}
        <div class="fields">
          <div class="field-label">Surname/Nom</div>
          <div class="field-value">${record.surname || ''}</div>
          <div class="field-label">Given Names/Prénoms</div>
          <div class="field-value">${givenNames}</div>
          <div class="dob-sex-row">
            <div>
              <div class="field-label">Date of Birth</div>
              <div class="field-value">${formatDobDisplay(record.birthdate)}</div>
            </div>
            <div>
              <div class="field-label">Sex/Sexe</div>
              <div class="field-value">${(record.gender || 'N/A').toUpperCase().slice(0, 1)}</div>
            </div>
          </div>
        </div>
        <div class="right-col">
          <div class="nga">NGA</div>
          <div class="issue-label">Issue Date</div>
          <div class="issue-value">${new Date().toLocaleDateString('en-GB')}</div>
        </div>
      </div>
      <div class="nin-row">
        <div class="nin-label">National Identification Number (NIN)</div>
        <div class="nin-digits">${(record.nin || nin || '').replace(/(\d{3})(?=\d)/g, '$1 ')}</div>
      </div>
    </div>
    <div class="disclaimer">${DISCLAIMER}</div>
  </body></html>`;
}

// Generic security-badge icon (shield + checkmark) — hand-drawn, not any
// specific bank/institution's trademark, used on the BVN Card design.
function shieldIconSvg(size = 40): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <path d="M32 4 L54 12 V30 C54 44 44 54 32 60 C20 54 10 44 10 30 V12 Z" fill="#eef2fb" stroke="#173a91" stroke-width="2.5"/>
    <path d="M22 32 L29 39 L43 24" fill="none" stroke="#173a91" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// Generic thumbs-up icon — universal symbol, not tied to any institution.
function thumbsUpIconSvg(size = 26): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M7 22H4a1 1 0 01-1-1v-9a1 1 0 011-1h3v11z" fill="#173a91"/>
    <path d="M9 21h8.5a2 2 0 001.98-1.7l1.34-8A2 2 0 0018.85 9H14l.7-4.2a2 2 0 00-1.97-2.32c-.42 0-.82.16-1.12.46L9 6v15z" fill="#2f7de0"/>
  </svg>`;
}

// Generic fingerprint icon — universal symbol, not tied to any institution.
function fingerprintIconSvg(size = 38): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="#111" stroke-width="1.3">
    <path d="M12 11c1 0 2 .8 2 2.2 0 3-1.2 5-2.6 6.3" stroke-linecap="round"/>
    <path d="M9 10.5c0-1.7 1.3-3 3-3s3 1.3 3 3c0 .5 0 1-.1 1.5" stroke-linecap="round"/>
    <path d="M6.5 9.5A6.5 6.5 0 0119 10c0 1.2-.1 2.3-.4 3.3" stroke-linecap="round"/>
    <path d="M5 13c-.3-1-.5-2-.5-3a7.5 7.5 0 0114.9-1.3" stroke-linecap="round"/>
    <path d="M7.5 17.5c-1-1.5-1.6-3.3-1.6-5" stroke-linecap="round"/>
    <path d="M15 15.2c.4-.7.6-1.5.6-2.3" stroke-linecap="round"/>
    <path d="M10.2 19.5c.7-.6 1.3-1.3 1.8-2.1" stroke-linecap="round"/>
  </svg>`;
}

// BVN Slip — the traditional tabular layout (field list + photo/BVN block +
// verified badge with notice text).
function buildBvnSlipTraditionalHtml(record: BvnRecord, bvn: string, emblemBase64: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <style>
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 24px; color: #111; background: #f4f4ee; }
    .slip { max-width: 760px; margin: 0 auto; background: #ffffff; border: 1px solid #ddd; border-radius: 10px; padding: 22px 26px; }
    .header { display: flex; align-items: center; justify-content: center; gap: 10px; border-bottom: 2px solid #1a5c3a; padding-bottom: 12px; margin-bottom: 16px; }
    .header h1 { font-size: 16px; margin: 0; color: #1a5c3a; text-align: center; }
    .header h2 { font-size: 13px; margin: 2px 0 0; color: #222; font-weight: 700; text-align: center; }
    .body-row { display: flex; gap: 16px; }
    .field-col { flex: 1.3; }
    .field-col-2 { flex: 0.75; }
    .field { margin-bottom: 7px; font-size: 10.5px; }
    .field .label { color: #555; }
    .field .value { font-weight: 700; color: #111; }
    .mid-col { flex: 0.9; text-align: center; }
    .photo { width: 78px; height: 90px; object-fit: cover; border: 1px solid #999; margin: 0 auto 8px; display: block; }
    .photo-blank { background: #ddd; }
    .bvn-label { font-size: 9px; color: #555; font-weight: 700; margin-top: 4px; }
    .bvn-value { font-size: 14px; font-weight: 800; letter-spacing: 1px; }
    .nin-label { font-size: 9px; color: #555; margin-top: 10px; }
    .right-col { flex: 1; }
    .verified { color: #1a8f4c; font-weight: 800; font-size: 15px; margin-bottom: 8px; }
    .notes { font-size: 8px; color: #444; line-height: 1.5; margin: 0; padding-left: 14px; }
    .notes li { margin-bottom: 4px; }
    .disclaimer { margin-top: 16px; font-size: 9px; color: #999; font-style: italic; text-align: center; }
  </style></head>
  <body>
    <div class="slip">
      <div class="header">
        ${emblemTag(emblemBase64, 'emblem', 40)}
        <div>
          <h1>Federal Republic of Nigeria</h1>
          <h2>Verified BVN Details</h2>
        </div>
      </div>
      <div class="body-row">
        <div class="field-col">
          <div class="field"><span class="label">First Name: </span><span class="value">${record.firstname || 'N/A'}</span></div>
          <div class="field"><span class="label">Middle Name: </span><span class="value">${record.middlename || 'N/A'}</span></div>
          <div class="field"><span class="label">Last Name: </span><span class="value">${record.lastname || 'N/A'}</span></div>
          <div class="field"><span class="label">Date of birth: </span><span class="value">${record.dob || 'N/A'}</span></div>
          <div class="field"><span class="label">Gender: </span><span class="value">${record.gender || 'N/A'}</span></div>
          <div class="field"><span class="label">Marital Status: </span><span class="value">N/A</span></div>
          <div class="field"><span class="label">Phone Number: </span><span class="value">${record.phone || 'N/A'}</span></div>
          <div class="field"><span class="label">Enrollment Institution: </span><span class="value">N/A</span></div>
          <div class="field"><span class="label">Origin State: </span><span class="value">${record.stateOfOrigin || 'N/A'}</span></div>
          <div class="field"><span class="label">Residence State: </span><span class="value">${record.stateOfResidence || 'N/A'}</span></div>
          <div class="field"><span class="label">Residential Address: </span><span class="value">N/A</span></div>
        </div>
        <div class="field-col-2">
          <div class="field"><span class="label">Enrollment Branch: </span><span class="value">N/A</span></div>
          <div class="field"><span class="label">Origin LGA: </span><span class="value">N/A</span></div>
          <div class="field"><span class="label">Residence LGA: </span><span class="value">N/A</span></div>
        </div>
        <div class="mid-col">
          ${photoTag(record.photo)}
          <div class="bvn-label">BVN</div>
          <div class="bvn-value">${(record.bvn || bvn || '').replace(/(\d{3})(?=\d)/g, '$1 ')}</div>
          <div class="nin-label">NIN:</div>
        </div>
        <div class="right-col">
          <div class="verified">✓ Verified</div>
          <ol class="notes">
            <li>The information on this slip remains valid until deactivated where necessary by an authorized body.</li>
            <li>Verify the information on this slip only through a channel approved by the Federal Government of Nigeria.</li>
            <li>The information shown on this slip is valid for the lifetime of the holder and does not expire.</li>
            <li>No liability is accepted for unauthorized alterations made to this slip after issue.</li>
          </ol>
        </div>
      </div>
      <div class="disclaimer">This is a reprint of verified BVN details for convenience and is not a replacement for official bank documentation.</div>
    </div>
  </body></html>`;
}

// BVN Card — the modern ID-card layout (bank-security iconography, no coat
// of arms: a BVN is a banking/NIBSS construct, not a NIMC-issued ID, so it
// gets its own bank-styled branding instead of the national emblem).
function buildBvnCardHtml(record: BvnRecord, bvn: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <style>
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 32px; color: #111; }
    .card { position: relative; width: 540px; margin: 0 auto; border: 1px solid #cdd7ea; border-radius: 10px; padding: 20px 24px; background: #f4f7fb; overflow: hidden; }
    .header-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
    .brand-row { display: flex; align-items: center; gap: 8px; }
    .brand-title { font-size: 15px; font-weight: 800; color: #173a91; line-height: 1.2; }
    .icons-row { display: flex; align-items: center; gap: 6px; }
    .content-row { display: flex; }
    .photo { width: 84px; height: 100px; object-fit: cover; border: 1px solid #99a; }
    .photo-blank { background: #cfd6e6; }
    .fields { margin-left: 16px; flex: 1; }
    .field-label { font-size: 9px; color: #5a6b8c; text-transform: uppercase; margin-top: 8px; letter-spacing: 0.4px; }
    .field-value { font-size: 14px; font-weight: 700; font-family: 'Courier New', monospace; color: #12203f; }
    .dob-gender-row { display: flex; gap: 28px; }
    .right-col { text-align: right; margin-left: 12px; min-width: 84px; }
    .nga { font-size: 20px; font-weight: 800; color: #111; margin-top: 8px; }
    .issue-label { font-size: 8.5px; color: #5a6b8c; margin-top: 10px; }
    .issue-value { font-size: 10px; font-weight: 700; color: #12203f; }
    .bvn-row { text-align: center; margin-top: 18px; }
    .bvn-label { font-size: 10px; color: #173a91; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; }
    .bvn-digits { font-size: 26px; font-weight: 800; letter-spacing: 6px; margin-top: 4px; font-family: 'Courier New', monospace; color: #0d1730; }
    .disclaimer { max-width: 540px; margin: 12px auto 0; font-size: 9px; color: #999; font-style: italic; text-align: center; }
  </style></head>
  <body>
    <div class="card">
      <div class="header-row">
        <div class="brand-row">
          ${shieldIconSvg(38)}
          <div class="brand-title">Bank<br/>Verification Number</div>
        </div>
        <div class="icons-row">
          ${thumbsUpIconSvg(26)}
          ${fingerprintIconSvg(38)}
        </div>
      </div>
      <div class="content-row">
        ${photoTag(record.photo)}
        <div class="fields">
          <div class="field-label">Surname</div>
          <div class="field-value">${record.lastname || ''}</div>
          <div class="field-label">First Name/Other Name</div>
          <div class="field-value">${record.firstname || ''} ${record.middlename || ''}</div>
          <div class="dob-gender-row">
            <div>
              <div class="field-label">Date of Birth</div>
              <div class="field-value">${formatDobDisplay(record.dob)}</div>
            </div>
            <div>
              <div class="field-label">Gender</div>
              <div class="field-value">${(record.gender || 'N/A').toUpperCase().slice(0, 1)}</div>
            </div>
          </div>
        </div>
        <div class="right-col">
          <div class="nga">NGA</div>
          <div class="issue-label">Issue Date</div>
          <div class="issue-value">${new Date().toLocaleDateString('en-GB')}</div>
        </div>
      </div>
      <div class="bvn-row">
        <div class="bvn-label">Bank Verification Number (BVN)</div>
        <div class="bvn-digits">${(record.bvn || bvn || '').replace(/(\d{3})(?=\d)/g, '$1 ')}</div>
      </div>
    </div>
    <div class="disclaimer">This is a reprint of verified BVN details for convenience and is not a replacement for official bank documentation.</div>
  </body></html>`;
}

interface NinServicesScreenProps {
  navigation: { goBack: () => void };
}

type Mode = 'verify' | 'validate' | 'bvn' | 'modify';
type VerifyState = 'idle' | 'processing' | 'result' | 'error';
type ValidateState = 'idle' | 'processing' | 'submitted' | 'error';
type BvnState = 'idle' | 'processing' | 'result' | 'error';
type ModifyState = 'idle' | 'processing' | 'submitted' | 'error';

// VERIFY_PRICE/BVN_VERIFY_PRICE: normally 1000. TEMPORARILY free (see
// VERIFICATION_FREE_FOR_TESTING below) for owner testing 2026-07-06 — see
// matching comment in nin-verify/bvn-verify edge functions. Flip the flag
// back to false (and nothing else needs to change here) once testing is done.
const VERIFICATION_FREE_FOR_TESTING = true;
const VERIFY_PRICE = 1000;
const VALIDATE_PRICE = 8000;
const BVN_VERIFY_PRICE = 1000;
const MODIFY_PRICE = 18000;

export default function NinServicesScreen({ navigation }: NinServicesScreenProps) {
  const { authorize } = useTransactionAuth();
  const [mode, setMode] = useState<Mode>('verify');

  // Verify state
  const [nin, setNin] = useState('');
  const [firstname, setFirstname] = useState('');
  const [surname, setSurname] = useState('');
  const [gender, setGender] = useState<'male' | 'female' | ''>('');
  const [birthdate, setBirthdate] = useState('');
  const [consent, setConsent] = useState(false);
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [verifyError, setVerifyError] = useState('');
  const [record, setRecord] = useState<NinRecord | null>(null);
  const [matches, setMatches] = useState<Record<string, boolean> | undefined>();
  const [printOpen, setPrintOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState<SlipTier>('regular');

  // Validate state
  const [validateNin, setValidateNin] = useState('');
  const [validateDob, setValidateDob] = useState('');
  const [validateConsent, setValidateConsent] = useState(false);
  const [validateState, setValidateState] = useState<ValidateState>('idle');
  const [validateMessage, setValidateMessage] = useState('');

  // BVN state
  const [bvnNumber, setBvnNumber] = useState('');
  const [bvnConsent, setBvnConsent] = useState(false);
  const [bvnState, setBvnState] = useState<BvnState>('idle');
  const [bvnError, setBvnError] = useState('');
  const [bvnRecord, setBvnRecord] = useState<BvnRecord | null>(null);

  // Modify (NIN correction) state
  const [modifyType, setModifyType] = useState<NinModificationType>('name');
  const [modNin, setModNin] = useState('');
  const [modSurname, setModSurname] = useState('');
  const [modFirstname, setModFirstname] = useState('');
  const [modPhoneNumber, setModPhoneNumber] = useState(''); // "on file" phone — used by name & address types
  const [modMiddlename, setModMiddlename] = useState(''); // phone type only, optional
  const [modNewSurname, setModNewSurname] = useState('');
  const [modNewFirstname, setModNewFirstname] = useState('');
  const [modNewPhoneNumber, setModNewPhoneNumber] = useState('');
  const [modNewAddress, setModNewAddress] = useState('');
  const [modConsent, setModConsent] = useState(false);
  const [modifyState, setModifyState] = useState<ModifyState>('idle');
  const [modifyMessage, setModifyMessage] = useState('');

  const isNinValid = /^\d{11}$/.test(nin);
  const canVerify = isNinValid && consent && verifyState !== 'processing';

  const isValidateNinValid = /^\d{11}$/.test(validateNin);
  const isValidateDobValid = /^\d{4}-\d{2}-\d{2}$/.test(validateDob);
  const canValidate = isValidateNinValid && isValidateDobValid && validateConsent && validateState !== 'processing';

  const isBvnValid = /^\d{11}$/.test(bvnNumber);
  const canVerifyBvn = isBvnValid && bvnConsent && bvnState !== 'processing';

  const isModNinValid = /^\d{11}$/.test(modNin);
  const canModify = useMemo(() => {
    if (!isModNinValid || !modSurname.trim() || !modFirstname.trim() || !modConsent || modifyState === 'processing') {
      return false;
    }
    if (modifyType === 'name') {
      return /^0\d{10}$/.test(modPhoneNumber) && !!modNewSurname.trim() && !!modNewFirstname.trim();
    }
    if (modifyType === 'phone') {
      return /^0\d{10}$/.test(modNewPhoneNumber);
    }
    return /^0\d{10}$/.test(modPhoneNumber) && !!modNewAddress.trim(); // address
  }, [
    isModNinValid, modSurname, modFirstname, modConsent, modifyState, modifyType,
    modPhoneNumber, modNewSurname, modNewFirstname, modNewPhoneNumber, modNewAddress,
  ]);

  const handleSwitchMode = useCallback((next: Mode) => {
    setMode(next);
    setPrintOpen(false);
  }, []);

  const handleVerify = useCallback(async () => {
    if (!canVerify) return;
    const authResult = await authorize({
      title: 'Confirm NIN Verification',
      amount: VERIFICATION_FREE_FOR_TESTING ? undefined : VERIFY_PRICE,
    });
    if (!authResult) return;

    setVerifyError('');
    setVerifyState('processing');

    const claimed = {
      firstname: firstname.trim() || undefined,
      surname: surname.trim() || undefined,
      gender: gender || undefined,
      birthdate: birthdate.trim() || undefined,
    };
    const hasClaim = Object.values(claimed).some(Boolean);

    const result = await ninService.verifyNin(nin, hasClaim ? claimed : undefined, authResult.token);
    if (result.success && result.record) {
      setRecord(result.record);
      setMatches(result.matches);
      setVerifyState('result');
    } else {
      setVerifyError(result.error || 'Could not verify this NIN. Please try again.');
      setVerifyState('error');
    }
  }, [canVerify, nin, firstname, surname, gender, birthdate, authorize]);

  const handleResetVerify = useCallback(() => {
    setVerifyState('idle');
    setVerifyError('');
    setRecord(null);
    setMatches(undefined);
    setPrintOpen(false);
    setNin('');
    setFirstname('');
    setSurname('');
    setGender('');
    setBirthdate('');
    setConsent(false);
  }, []);

  const handleValidate = useCallback(async () => {
    if (!canValidate) return;
    const authResult = await authorize({ title: 'Confirm NIN Validation', amount: VALIDATE_PRICE });
    if (!authResult) return;

    setValidateState('processing');
    const result = await ninService.submitValidation(validateNin, validateDob, authResult.token);
    if (result.success) {
      setValidateMessage(result.message || 'Validation submitted.');
      setValidateState('submitted');
    } else {
      setValidateMessage(result.error || 'Could not submit validation request.');
      setValidateState('error');
    }
  }, [canValidate, validateNin, validateDob, authorize]);

  const handleResetValidate = useCallback(() => {
    setValidateState('idle');
    setValidateMessage('');
    setValidateNin('');
    setValidateDob('');
    setValidateConsent(false);
  }, []);

  const handleVerifyBvn = useCallback(async () => {
    if (!canVerifyBvn) return;
    const authResult = await authorize({
      title: 'Confirm BVN Verification',
      amount: VERIFICATION_FREE_FOR_TESTING ? undefined : BVN_VERIFY_PRICE,
    });
    if (!authResult) return;

    setBvnError('');
    setBvnState('processing');
    const result = await ninService.verifyBvn(bvnNumber, authResult.token);
    if (result.success && result.record) {
      setBvnRecord(result.record);
      setBvnState('result');
    } else {
      setBvnError(result.error || 'Could not verify this BVN. Please try again.');
      setBvnState('error');
    }
  }, [canVerifyBvn, bvnNumber, authorize]);

  const handleResetBvn = useCallback(() => {
    setBvnState('idle');
    setBvnError('');
    setBvnRecord(null);
    setBvnNumber('');
    setBvnConsent(false);
    setBvnPrintOpen(false);
  }, []);

  const [generatingBvnPdf, setGeneratingBvnPdf] = useState(false);
  const [bvnPrintOpen, setBvnPrintOpen] = useState(false);
  const [selectedBvnTier, setSelectedBvnTier] = useState<BvnSlipTier>('slip');

  const bvnFullName = useMemo(() => {
    if (!bvnRecord) return '';
    return [bvnRecord.firstname, bvnRecord.middlename, bvnRecord.lastname].filter(Boolean).join(' ');
  }, [bvnRecord]);

  const buildSelectedBvnSlipHtml = useCallback(async () => {
    const emblemBase64 = await getEmblemBase64();
    return selectedBvnTier === 'slip'
      ? buildBvnSlipTraditionalHtml(bvnRecord!, bvnNumber, emblemBase64)
      : buildBvnCardHtml(bvnRecord!, bvnNumber);
  }, [bvnRecord, selectedBvnTier, bvnNumber]);

  const handleDownloadBvn = useCallback(async () => {
    if (!bvnRecord) return;
    setGeneratingBvnPdf(true);
    try {
      const html = await buildSelectedBvnSlipHtml();
      const tierName = BVN_SLIP_TIERS.find((t) => t.id === selectedBvnTier)?.name || 'BVN Slip';
      await downloadPdf(html, `${tierName.replace(/\s+/g, '_')}_${bvnNumber}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'PDF saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', (e as Error).message || 'Could not save the PDF. Please try again.');
    } finally {
      setGeneratingBvnPdf(false);
    }
  }, [bvnRecord, selectedBvnTier, buildSelectedBvnSlipHtml, bvnNumber]);

  const handleShareBvn = useCallback(async () => {
    if (!bvnRecord) return;
    setGeneratingBvnPdf(true);
    try {
      const html = await buildSelectedBvnSlipHtml();
      const tierName = BVN_SLIP_TIERS.find((t) => t.id === selectedBvnTier)?.name || 'BVN Slip';
      await sharePdf(html, `Share your ${tierName}`);
    } catch (e) {
      Alert.alert('Error', (e as Error).message || 'Could not generate the PDF. Please try again.');
    } finally {
      setGeneratingBvnPdf(false);
    }
  }, [bvnRecord, selectedBvnTier, buildSelectedBvnSlipHtml]);

  const handleModify = useCallback(async () => {
    if (!canModify) return;
    const titles: Record<NinModificationType, string> = {
      name: 'Confirm Name Correction Request',
      phone: 'Confirm Phone Number Update Request',
      address: 'Confirm Address Update Request',
    };
    const authResult = await authorize({ title: titles[modifyType], amount: MODIFY_PRICE });
    if (!authResult) return;

    setModifyState('processing');
    const fields: Record<string, string> = { nin: modNin, surname: modSurname.trim(), firstname: modFirstname.trim() };
    if (modifyType === 'name') {
      fields.phone_number = modPhoneNumber;
      fields.new_surname = modNewSurname.trim();
      fields.new_firstname = modNewFirstname.trim();
    } else if (modifyType === 'phone') {
      fields.middlename = modMiddlename.trim();
      fields.new_phone_number = modNewPhoneNumber;
    } else {
      fields.phone_number = modPhoneNumber;
      fields.new_address = modNewAddress.trim();
    }

    const result = await ninService.submitModification(modifyType, fields as any, authResult.token);
    if (result.success) {
      setModifyMessage(result.message || 'Request submitted.');
      setModifyState('submitted');
    } else {
      setModifyMessage(result.error || 'Could not submit this request.');
      setModifyState('error');
    }
  }, [
    canModify, modifyType, modNin, modSurname, modFirstname, modPhoneNumber,
    modMiddlename, modNewSurname, modNewFirstname, modNewPhoneNumber, modNewAddress, authorize,
  ]);

  const handleResetModify = useCallback(() => {
    setModifyState('idle');
    setModifyMessage('');
    setModNin('');
    setModSurname('');
    setModFirstname('');
    setModPhoneNumber('');
    setModMiddlename('');
    setModNewSurname('');
    setModNewFirstname('');
    setModNewPhoneNumber('');
    setModNewAddress('');
    setModConsent(false);
  }, []);

  const fullName = useMemo(() => {
    if (!record) return '';
    return [record.firstname, record.middlename, record.surname].filter(Boolean).join(' ');
  }, [record]);

  const [generatingPdf, setGeneratingPdf] = useState(false);

  const buildSelectedSlipHtml = useCallback(async () => {
    const emblemBase64 = await getEmblemBase64();
    return selectedTier === 'regular'
      ? buildRegularSlipHtml(record!, fullName, nin, emblemBase64)
      : buildStandardSlipHtml(record!, fullName, nin, selectedTier === 'premium', emblemBase64);
  }, [record, selectedTier, fullName, nin]);

  const handleDownload = useCallback(async () => {
    if (!record) return;
    setGeneratingPdf(true);
    try {
      const html = await buildSelectedSlipHtml();
      const tierName = SLIP_TIERS.find((t) => t.id === selectedTier)?.name || 'NIN Slip';
      await downloadPdf(html, `${tierName.replace(/\s+/g, '_')}_${nin}`);
      Alert.alert(
        Platform.OS === 'android' ? 'Downloaded' : 'Saved',
        Platform.OS === 'android' ? 'PDF saved to the folder you selected.' : 'Choose "Save to Files" to store it on your device.',
      );
    } catch (e) {
      Alert.alert('Error', (e as Error).message || 'Could not save the PDF. Please try again.');
    } finally {
      setGeneratingPdf(false);
    }
  }, [record, selectedTier, buildSelectedSlipHtml, nin]);

  const handleShare = useCallback(async () => {
    if (!record) return;
    setGeneratingPdf(true);
    try {
      const html = await buildSelectedSlipHtml();
      const tierName = SLIP_TIERS.find((t) => t.id === selectedTier)?.name || 'NIN Slip';
      await sharePdf(html, `Share your ${tierName}`);
    } catch (e) {
      Alert.alert('Error', (e as Error).message || 'Could not generate the PDF. Please try again.');
    } finally {
      setGeneratingPdf(false);
    }
  }, [record, selectedTier, buildSelectedSlipHtml]);

  const renderMatchRow = (label: string, key: string) => {
    if (!matches || !(key in matches)) return null;
    const ok = matches[key];
    return (
      <View style={styles.matchRow} key={key}>
        <Text style={styles.matchLabel}>{label}</Text>
        <Text style={[styles.matchIcon, { color: ok ? Colors.GREEN : Colors.RED }]}>
          {ok ? '✓ Matches' : '✗ Mismatch'}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>

          <Text style={styles.title}>NIN Services</Text>

          <View style={styles.segmentedControl}>
            <TouchableOpacity
              style={[styles.segment, mode === 'verify' && styles.segmentActive]}
              onPress={() => handleSwitchMode('verify')}
            >
              <Text style={[styles.segmentText, mode === 'verify' && styles.segmentTextActive]}>NIN</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segment, mode === 'validate' && styles.segmentActive]}
              onPress={() => handleSwitchMode('validate')}
            >
              <Text style={[styles.segmentText, mode === 'validate' && styles.segmentTextActive]}>Validate</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segment, mode === 'bvn' && styles.segmentActive]}
              onPress={() => handleSwitchMode('bvn')}
            >
              <Text style={[styles.segmentText, mode === 'bvn' && styles.segmentTextActive]}>BVN</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segment, mode === 'modify' && styles.segmentActive]}
              onPress={() => handleSwitchMode('modify')}
            >
              <Text style={[styles.segmentText, mode === 'modify' && styles.segmentTextActive]}>Update</Text>
            </TouchableOpacity>
          </View>

          {mode === 'verify' && verifyState !== 'result' && (
            <View>
              <Text style={styles.helperText}>
                Confirm a NIN's on-file details — used to check that submitted information (e.g. for a bank, school, or SIM registration) is genuine.
              </Text>

              <Text style={styles.label}>NIN Number</Text>
              <TextInput
                style={styles.input}
                value={nin}
                onChangeText={(t) => setNin(t.replace(/[^0-9]/g, '').slice(0, 11))}
                placeholder="Enter 11-digit NIN"
                placeholderTextColor={Colors.GRAY}
                keyboardType="number-pad"
                maxLength={11}
              />

              <Text style={styles.label}>Claimed Details (optional — leave blank to just confirm the NIN exists)</Text>
              <TextInput
                style={styles.input}
                value={firstname}
                onChangeText={setFirstname}
                placeholder="First name"
                placeholderTextColor={Colors.GRAY}
              />
              <TextInput
                style={styles.input}
                value={surname}
                onChangeText={setSurname}
                placeholder="Surname"
                placeholderTextColor={Colors.GRAY}
              />
              <View style={styles.genderRow}>
                {(['male', 'female'] as const).map((g) => (
                  <TouchableOpacity
                    key={g}
                    style={[styles.genderButton, gender === g && styles.genderButtonSelected]}
                    onPress={() => setGender(gender === g ? '' : g)}
                  >
                    <Text style={[styles.genderText, gender === g && styles.genderTextSelected]}>
                      {g === 'male' ? 'Male' : 'Female'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                style={styles.input}
                value={birthdate}
                onChangeText={(t) => setBirthdate(t.replace(/[^0-9-]/g, '').slice(0, 10))}
                placeholder="Date of Birth (YYYY-MM-DD)"
                placeholderTextColor={Colors.GRAY}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />

              <TouchableOpacity style={styles.consentRow} onPress={() => setConsent(!consent)}>
                <View style={[styles.checkbox, consent && styles.checkboxChecked]}>
                  {consent && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <Text style={styles.consentText}>
                  I consent to this NIN being checked against NIMC's database.
                </Text>
              </TouchableOpacity>

              {verifyError ? <Text style={styles.errorText}>{verifyError}</Text> : null}

              <TouchableOpacity
                style={[styles.primaryButton, !canVerify && styles.primaryButtonDisabled]}
                onPress={handleVerify}
                disabled={!canVerify}
              >
                {verifyState === 'processing' ? (
                  <ActivityIndicator color={Colors.WHITE} />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    Verify ({VERIFICATION_FREE_FOR_TESTING ? 'Free' : formatNaira(VERIFY_PRICE)})
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {mode === 'verify' && verifyState === 'result' && record && (
            <View>
              {!printOpen ? (
                <View>
                  <View style={styles.resultCard}>
                    <Text style={styles.resultName}>{fullName}</Text>
                    <View style={styles.resultRow}>
                      <Text style={styles.resultLabel}>NIN</Text>
                      <Text style={styles.resultValue}>{record.nin || nin}</Text>
                    </View>
                    <View style={styles.resultRow}>
                      <Text style={styles.resultLabel}>Date of Birth</Text>
                      <Text style={styles.resultValue}>{record.birthdate || 'N/A'}</Text>
                    </View>
                    <View style={styles.resultRow}>
                      <Text style={styles.resultLabel}>Gender</Text>
                      <Text style={styles.resultValue}>{record.gender || 'N/A'}</Text>
                    </View>
                    <View style={styles.resultRow}>
                      <Text style={styles.resultLabel}>Phone</Text>
                      <Text style={styles.resultValue}>{record.telephoneno || 'N/A'}</Text>
                    </View>
                  </View>

                  {matches && Object.keys(matches).length > 0 && (
                    <View style={styles.matchCard}>
                      <Text style={styles.matchTitle}>Submitted Details Comparison</Text>
                      {renderMatchRow('First Name', 'firstname')}
                      {renderMatchRow('Surname', 'surname')}
                      {renderMatchRow('Gender', 'gender')}
                      {renderMatchRow('Date of Birth', 'birthdate')}
                    </View>
                  )}

                  <TouchableOpacity style={styles.secondaryButton} onPress={() => setPrintOpen(true)}>
                    <Text style={styles.secondaryButtonText}>Get Printable NIN Slip</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.primaryButton} onPress={handleResetVerify}>
                    <Text style={styles.primaryButtonText}>Done</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View>
                  <Text style={styles.stepLabel}>01  Select Slip Type</Text>
                  <View style={styles.tierRow}>
                    {SLIP_TIERS.map((tier) => {
                      const isSelected = selectedTier === tier.id;
                      return (
                        <TouchableOpacity
                          key={tier.id}
                          style={[styles.tierCard, isSelected && styles.tierCardSelected]}
                          onPress={() => setSelectedTier(tier.id)}
                        >
                          <View style={[styles.radio, isSelected && styles.radioSelected]}>
                            {isSelected && <View style={styles.radioDot} />}
                          </View>
                          <Text style={styles.tierName}>{tier.name}</Text>
                          <Text style={styles.tierValue}>{formatNaira(tier.valueKobo / 100)}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={styles.freeNote}>Free to generate — the price above just shows the slip's typical value.</Text>

                  {selectedTier === 'regular' ? (
                    <View style={styles.regularPreview}>
                      <View style={styles.regularPreviewHeader}>
                        <Image source={EMBLEM_ASSET} style={styles.regularPreviewEmblem} />
                        <View style={styles.regularPreviewTitleBlock}>
                          <Text style={styles.regularPreviewTitle}>National Identity Management System</Text>
                          <Text style={styles.regularPreviewSub}>Federal Republic of Nigeria</Text>
                        </View>
                        <View style={styles.regularPreviewEmblemSpacer} />
                      </View>
                      <View style={styles.regularPreviewBody}>
                        <View style={styles.regularPreviewFields}>
                          <Text style={styles.regularPreviewField}>NIN: {record.nin || nin}</Text>
                          <Text style={styles.regularPreviewField}>Surname: {record.surname || ''}</Text>
                          <Text style={styles.regularPreviewField}>First Name: {record.firstname || ''}</Text>
                          <Text style={styles.regularPreviewField}>Gender: {(record.gender || '').toUpperCase()}</Text>
                        </View>
                        {record.photo ? (
                          <Image source={{ uri: `data:image/jpeg;base64,${record.photo}` }} style={styles.regularPreviewPhoto} />
                        ) : (
                          <View style={styles.regularPreviewPhotoBlank} />
                        )}
                      </View>
                    </View>
                  ) : (
                    <View style={[styles.cardPreview, selectedTier === 'premium' && styles.cardPreviewPremium]}>
                      <Image source={EMBLEM_ASSET} style={styles.cardPreviewWatermark} />
                      <View style={styles.cardPreviewHeaderRow}>
                        <View>
                          {selectedTier === 'premium' && (
                            <Text style={styles.cardPreviewBrandFed}>FEDERAL REPUBLIC OF NIGERIA</Text>
                          )}
                          <Text style={styles.cardPreviewBrandSub}>DIGITAL NIN SLIP</Text>
                        </View>
                      </View>
                      <View style={styles.cardPreviewRow}>
                        {record.photo ? (
                          <Image source={{ uri: `data:image/jpeg;base64,${record.photo}` }} style={styles.cardPreviewPhoto} />
                        ) : (
                          <View style={styles.cardPreviewPhotoBlank} />
                        )}
                        <View style={styles.cardPreviewFields}>
                          <Text style={styles.cardPreviewLabel}>Surname/Nom</Text>
                          <Text style={styles.cardPreviewValue}>{record.surname || ''}</Text>
                          <Text style={styles.cardPreviewLabel}>Given Names/Prénoms</Text>
                          <Text style={styles.cardPreviewValue}>{fullName}</Text>
                          <View style={styles.cardPreviewDobSexRow}>
                            <View>
                              <Text style={styles.cardPreviewLabel}>Date of Birth</Text>
                              <Text style={styles.cardPreviewValue}>{formatDobDisplay(record.birthdate)}</Text>
                            </View>
                            <View>
                              <Text style={styles.cardPreviewLabel}>Sex/Sexe</Text>
                              <Text style={styles.cardPreviewValue}>{(record.gender || 'N/A').toUpperCase().slice(0, 1)}</Text>
                            </View>
                          </View>
                        </View>
                        <View style={styles.cardPreviewRightCol}>
                          <Text style={styles.cardPreviewNga}>NGA</Text>
                          <Text style={styles.cardPreviewIssueLabel}>Issue Date</Text>
                          <Text style={styles.cardPreviewIssueValue}>{new Date().toLocaleDateString('en-GB')}</Text>
                        </View>
                      </View>
                      <Text style={styles.cardPreviewNinLabel}>National Identification Number (NIN)</Text>
                      <Text style={styles.cardPreviewNin}>{record.nin || nin}</Text>
                    </View>
                  )}

                  <Text style={styles.printDisclaimer}>{'\n'}{DISCLAIMER}</Text>

                  <TouchableOpacity
                    style={[styles.primaryButton, generatingPdf && styles.primaryButtonDisabled]}
                    onPress={handleDownload}
                    disabled={generatingPdf}
                  >
                    {generatingPdf ? (
                      <ActivityIndicator color={Colors.WHITE} />
                    ) : (
                      <Text style={styles.primaryButtonText}>Download PDF</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.secondaryButton, generatingPdf && styles.primaryButtonDisabled]}
                    onPress={handleShare}
                    disabled={generatingPdf}
                  >
                    <Text style={styles.secondaryButtonText}>Share PDF</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => setPrintOpen(false)} disabled={generatingPdf}>
                    <Text style={styles.secondaryButtonText}>Back to Result</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {mode === 'validate' && validateState !== 'submitted' && (
            <View>
              <Text style={styles.helperText}>
                Confirms a NIN was genuinely issued and is active in NIMC's database — for NINs that exist but aren't reflecting properly elsewhere. This is not instant: results typically take 24-48 hours.
              </Text>

              <Text style={styles.label}>NIN Number</Text>
              <TextInput
                style={styles.input}
                value={validateNin}
                onChangeText={(t) => setValidateNin(t.replace(/[^0-9]/g, '').slice(0, 11))}
                placeholder="Enter 11-digit NIN"
                placeholderTextColor={Colors.GRAY}
                keyboardType="number-pad"
                maxLength={11}
              />

              <Text style={styles.label}>Date of Birth</Text>
              <TextInput
                style={styles.input}
                value={validateDob}
                onChangeText={(t) => setValidateDob(t.replace(/[^0-9-]/g, '').slice(0, 10))}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={Colors.GRAY}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />

              <TouchableOpacity style={styles.consentRow} onPress={() => setValidateConsent(!validateConsent)}>
                <View style={[styles.checkbox, validateConsent && styles.checkboxChecked]}>
                  {validateConsent && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <Text style={styles.consentText}>
                  I consent to this NIN being submitted for validation with NIMC.
                </Text>
              </TouchableOpacity>

              {validateState === 'error' ? <Text style={styles.errorText}>{validateMessage}</Text> : null}

              <TouchableOpacity
                style={[styles.primaryButton, !canValidate && styles.primaryButtonDisabled]}
                onPress={handleValidate}
                disabled={!canValidate}
              >
                {validateState === 'processing' ? (
                  <ActivityIndicator color={Colors.WHITE} />
                ) : (
                  <Text style={styles.primaryButtonText}>Submit Validation ({formatNaira(VALIDATE_PRICE)})</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {mode === 'validate' && validateState === 'submitted' && (
            <View style={styles.resultCard}>
              <Text style={styles.resultName}>Validation Submitted</Text>
              <Text style={styles.helperText}>{validateMessage}</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={handleResetValidate}>
                <Text style={styles.primaryButtonText}>Done</Text>
              </TouchableOpacity>
            </View>
          )}

          {mode === 'bvn' && bvnState !== 'result' && (
            <View>
              <Text style={styles.helperText}>
                Confirm a Bank Verification Number is genuine and retrieve the account holder's on-file details.
              </Text>

              <Text style={styles.label}>BVN Number</Text>
              <TextInput
                style={styles.input}
                value={bvnNumber}
                onChangeText={(t) => setBvnNumber(t.replace(/[^0-9]/g, '').slice(0, 11))}
                placeholder="Enter 11-digit BVN"
                placeholderTextColor={Colors.GRAY}
                keyboardType="number-pad"
                maxLength={11}
              />

              <TouchableOpacity style={styles.consentRow} onPress={() => setBvnConsent(!bvnConsent)}>
                <View style={[styles.checkbox, bvnConsent && styles.checkboxChecked]}>
                  {bvnConsent && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <Text style={styles.consentText}>I consent to this BVN being checked.</Text>
              </TouchableOpacity>

              {bvnError ? <Text style={styles.errorText}>{bvnError}</Text> : null}

              <TouchableOpacity
                style={[styles.primaryButton, !canVerifyBvn && styles.primaryButtonDisabled]}
                onPress={handleVerifyBvn}
                disabled={!canVerifyBvn}
              >
                {bvnState === 'processing' ? (
                  <ActivityIndicator color={Colors.WHITE} />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    Verify ({VERIFICATION_FREE_FOR_TESTING ? 'Free' : formatNaira(BVN_VERIFY_PRICE)})
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {mode === 'bvn' && bvnState === 'result' && bvnRecord && (
            <View>
              {!bvnPrintOpen ? (
                <View>
                  <View style={styles.resultCard}>
                    <Text style={styles.resultName}>{bvnFullName}</Text>
                    <View style={styles.resultRow}>
                      <Text style={styles.resultLabel}>BVN</Text>
                      <Text style={styles.resultValue}>{bvnRecord.bvn || bvnNumber}</Text>
                    </View>
                    <View style={styles.resultRow}>
                      <Text style={styles.resultLabel}>Date of Birth</Text>
                      <Text style={styles.resultValue}>{bvnRecord.dob || 'N/A'}</Text>
                    </View>
                    <View style={styles.resultRow}>
                      <Text style={styles.resultLabel}>Gender</Text>
                      <Text style={styles.resultValue}>{bvnRecord.gender || 'N/A'}</Text>
                    </View>
                    <View style={styles.resultRow}>
                      <Text style={styles.resultLabel}>Phone</Text>
                      <Text style={styles.resultValue}>{bvnRecord.phone || 'N/A'}</Text>
                    </View>
                  </View>

                  <TouchableOpacity style={styles.secondaryButton} onPress={() => setBvnPrintOpen(true)}>
                    <Text style={styles.secondaryButtonText}>Get Printable BVN Slip</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.primaryButton} onPress={handleResetBvn}>
                    <Text style={styles.primaryButtonText}>Done</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View>
                  <Text style={styles.stepLabel}>01  Select Slip Type</Text>
                  <View style={styles.tierRow}>
                    {BVN_SLIP_TIERS.map((tier) => {
                      const isSelected = selectedBvnTier === tier.id;
                      return (
                        <TouchableOpacity
                          key={tier.id}
                          style={[styles.tierCard, isSelected && styles.tierCardSelected]}
                          onPress={() => setSelectedBvnTier(tier.id)}
                        >
                          <View style={[styles.radio, isSelected && styles.radioSelected]}>
                            {isSelected && <View style={styles.radioDot} />}
                          </View>
                          <Text style={styles.tierName}>{tier.name}</Text>
                          <Text style={styles.tierValue}>{formatNaira(tier.valueKobo / 100)}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <Text style={styles.freeNote}>Free to generate — the price above just shows the slip's typical value.</Text>

                  {selectedBvnTier === 'slip' ? (
                    <View style={styles.regularPreview}>
                      <View style={styles.regularPreviewHeader}>
                        <Image source={EMBLEM_ASSET} style={styles.regularPreviewEmblem} />
                        <View style={styles.regularPreviewTitleBlock}>
                          <Text style={styles.regularPreviewTitle}>Federal Republic of Nigeria</Text>
                          <Text style={styles.regularPreviewSub}>Verified BVN Details</Text>
                        </View>
                        <View style={styles.regularPreviewEmblemSpacer} />
                      </View>
                      <View style={styles.regularPreviewBody}>
                        <View style={styles.regularPreviewFields}>
                          <Text style={styles.regularPreviewField}>First Name: {bvnRecord.firstname || 'N/A'}</Text>
                          <Text style={styles.regularPreviewField}>Last Name: {bvnRecord.lastname || 'N/A'}</Text>
                          <Text style={styles.regularPreviewField}>Date of birth: {bvnRecord.dob || 'N/A'}</Text>
                          <Text style={styles.regularPreviewField}>Gender: {bvnRecord.gender || 'N/A'}</Text>
                          <Text style={styles.regularPreviewField}>BVN: {(bvnRecord.bvn || bvnNumber || '').replace(/(\d{3})(?=\d)/g, '$1 ')}</Text>
                        </View>
                        {bvnRecord.photo ? (
                          <Image source={{ uri: `data:image/jpeg;base64,${bvnRecord.photo}` }} style={styles.regularPreviewPhoto} />
                        ) : (
                          <View style={styles.regularPreviewPhotoBlank} />
                        )}
                      </View>
                    </View>
                  ) : (
                    <View style={styles.cardPreview}>
                      <View style={styles.cardPreviewHeaderRow}>
                        <Text style={styles.cardPreviewBrandSub}>Bank Verification Number</Text>
                      </View>
                      <View style={styles.cardPreviewRow}>
                        {bvnRecord.photo ? (
                          <Image source={{ uri: `data:image/jpeg;base64,${bvnRecord.photo}` }} style={styles.cardPreviewPhoto} />
                        ) : (
                          <View style={styles.cardPreviewPhotoBlank} />
                        )}
                        <View style={styles.cardPreviewFields}>
                          <Text style={styles.cardPreviewLabel}>Surname</Text>
                          <Text style={styles.cardPreviewValue}>{bvnRecord.lastname || ''}</Text>
                          <Text style={styles.cardPreviewLabel}>First Name/Other Name</Text>
                          <Text style={styles.cardPreviewValue}>{bvnRecord.firstname || ''} {bvnRecord.middlename || ''}</Text>
                          <View style={styles.cardPreviewDobSexRow}>
                            <View>
                              <Text style={styles.cardPreviewLabel}>Date of Birth</Text>
                              <Text style={styles.cardPreviewValue}>{formatDobDisplay(bvnRecord.dob)}</Text>
                            </View>
                            <View>
                              <Text style={styles.cardPreviewLabel}>Gender</Text>
                              <Text style={styles.cardPreviewValue}>{(bvnRecord.gender || 'N/A').toUpperCase().slice(0, 1)}</Text>
                            </View>
                          </View>
                        </View>
                        <View style={styles.cardPreviewRightCol}>
                          <Text style={styles.cardPreviewNga}>NGA</Text>
                          <Text style={styles.cardPreviewIssueLabel}>Issue Date</Text>
                          <Text style={styles.cardPreviewIssueValue}>{new Date().toLocaleDateString('en-GB')}</Text>
                        </View>
                      </View>
                      <Text style={styles.cardPreviewNinLabel}>Bank Verification Number (BVN)</Text>
                      <Text style={styles.cardPreviewNin}>{(bvnRecord.bvn || bvnNumber || '').replace(/(\d{3})(?=\d)/g, '$1 ')}</Text>
                    </View>
                  )}

                  <TouchableOpacity
                    style={[styles.primaryButton, generatingBvnPdf && styles.primaryButtonDisabled]}
                    onPress={handleDownloadBvn}
                    disabled={generatingBvnPdf}
                  >
                    {generatingBvnPdf ? (
                      <ActivityIndicator color={Colors.WHITE} />
                    ) : (
                      <Text style={styles.primaryButtonText}>Download PDF</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.secondaryButton, generatingBvnPdf && styles.primaryButtonDisabled]}
                    onPress={handleShareBvn}
                    disabled={generatingBvnPdf}
                  >
                    <Text style={styles.secondaryButtonText}>Share PDF</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => setBvnPrintOpen(false)} disabled={generatingBvnPdf}>
                    <Text style={styles.secondaryButtonText}>Back to Result</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {mode === 'modify' && modifyState !== 'submitted' && (
            <View>
              <Text style={styles.helperText}>
                Request a correction to your NIN record with NIMC. This is not instant — reviewed orders typically take 24-48 hours, and the fee is charged upfront (refunded only if NIMC rejects it).
              </Text>

              <View style={styles.genderRow}>
                {(['name', 'phone', 'address'] as const).map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.genderButton, modifyType === t && styles.genderButtonSelected]}
                    onPress={() => setModifyType(t)}
                  >
                    <Text style={[styles.genderText, modifyType === t && styles.genderTextSelected]}>
                      {t === 'name' ? 'Name' : t === 'phone' ? 'Phone' : 'Address'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>NIN Number</Text>
              <TextInput
                style={styles.input}
                value={modNin}
                onChangeText={(t) => setModNin(t.replace(/[^0-9]/g, '').slice(0, 11))}
                placeholder="Enter 11-digit NIN"
                placeholderTextColor={Colors.GRAY}
                keyboardType="number-pad"
                maxLength={11}
              />

              <Text style={styles.label}>Current Details (as it appears on your NIN today)</Text>
              <TextInput
                style={styles.input}
                value={modSurname}
                onChangeText={setModSurname}
                placeholder="Current surname"
                placeholderTextColor={Colors.GRAY}
              />
              <TextInput
                style={styles.input}
                value={modFirstname}
                onChangeText={setModFirstname}
                placeholder="Current first name"
                placeholderTextColor={Colors.GRAY}
              />
              {modifyType === 'phone' ? (
                <TextInput
                  style={styles.input}
                  value={modMiddlename}
                  onChangeText={setModMiddlename}
                  placeholder="Middle name (optional)"
                  placeholderTextColor={Colors.GRAY}
                />
              ) : (
                <TextInput
                  style={styles.input}
                  value={modPhoneNumber}
                  onChangeText={(t) => setModPhoneNumber(t.replace(/[^0-9]/g, '').slice(0, 11))}
                  placeholder="Phone number on file"
                  placeholderTextColor={Colors.GRAY}
                  keyboardType="number-pad"
                  maxLength={11}
                />
              )}

              <Text style={styles.label}>
                {modifyType === 'name' ? 'Corrected Name' : modifyType === 'phone' ? 'New Phone Number' : 'Corrected Address'}
              </Text>
              {modifyType === 'name' && (
                <>
                  <TextInput
                    style={styles.input}
                    value={modNewSurname}
                    onChangeText={setModNewSurname}
                    placeholder="Corrected surname"
                    placeholderTextColor={Colors.GRAY}
                  />
                  <TextInput
                    style={styles.input}
                    value={modNewFirstname}
                    onChangeText={setModNewFirstname}
                    placeholder="Corrected first name"
                    placeholderTextColor={Colors.GRAY}
                  />
                </>
              )}
              {modifyType === 'phone' && (
                <TextInput
                  style={styles.input}
                  value={modNewPhoneNumber}
                  onChangeText={(t) => setModNewPhoneNumber(t.replace(/[^0-9]/g, '').slice(0, 11))}
                  placeholder="New phone number (0XXXXXXXXXX)"
                  placeholderTextColor={Colors.GRAY}
                  keyboardType="number-pad"
                  maxLength={11}
                />
              )}
              {modifyType === 'address' && (
                <TextInput
                  style={styles.input}
                  value={modNewAddress}
                  onChangeText={setModNewAddress}
                  placeholder="New residential address"
                  placeholderTextColor={Colors.GRAY}
                />
              )}

              <TouchableOpacity style={styles.consentRow} onPress={() => setModConsent(!modConsent)}>
                <View style={[styles.checkbox, modConsent && styles.checkboxChecked]}>
                  {modConsent && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <Text style={styles.consentText}>
                  I consent to this correction request being submitted to NIMC. I understand the fee is charged upfront and is only refunded if the request is rejected.
                </Text>
              </TouchableOpacity>

              {modifyState === 'error' ? <Text style={styles.errorText}>{modifyMessage}</Text> : null}

              <TouchableOpacity
                style={[styles.primaryButton, !canModify && styles.primaryButtonDisabled]}
                onPress={handleModify}
                disabled={!canModify}
              >
                {modifyState === 'processing' ? (
                  <ActivityIndicator color={Colors.WHITE} />
                ) : (
                  <Text style={styles.primaryButtonText}>Submit Request ({formatNaira(MODIFY_PRICE)})</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {mode === 'modify' && modifyState === 'submitted' && (
            <View style={styles.resultCard}>
              <Text style={styles.resultName}>Request Submitted</Text>
              <Text style={styles.helperText}>{modifyMessage}</Text>
              <TouchableOpacity style={styles.primaryButton} onPress={handleResetModify}>
                <Text style={styles.primaryButtonText}>Done</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  flex: { flex: 1 },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingTop: Spacing.M, paddingBottom: Spacing.XL },
  backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.L },
  backText: { fontSize: 28, fontWeight: '600', color: Colors.DARK },
  title: { ...Typography.SCREEN_TITLE, marginBottom: Spacing.L },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: Spacing.BUTTON_RADIUS,
    padding: 4,
    marginBottom: Spacing.L,
  },
  segment: { flex: 1, paddingVertical: Spacing.M, alignItems: 'center', borderRadius: Spacing.BUTTON_RADIUS - 2 },
  segmentActive: { backgroundColor: Colors.GREEN_LIGHT },
  segmentText: { ...Typography.BODY, color: Colors.GRAY, fontWeight: '600' },
  segmentTextActive: { color: Colors.GREEN_DARK },
  helperText: { ...Typography.CAPTION, color: Colors.GRAY, marginBottom: Spacing.L },
  label: { ...Typography.SECTION_HEADING, marginBottom: Spacing.M, marginTop: Spacing.S },
  input: {
    height: Spacing.INPUT_HEIGHT,
    borderWidth: Spacing.INPUT_BORDER_WIDTH,
    borderColor: Colors.BORDER,
    borderRadius: Spacing.BUTTON_RADIUS,
    paddingHorizontal: Spacing.L,
    ...Typography.BODY,
    color: Colors.DARK,
    marginBottom: Spacing.M,
  },
  genderRow: { flexDirection: 'row', gap: Spacing.M, marginBottom: Spacing.M },
  genderButton: {
    flex: 1,
    height: Spacing.CHIP_HEIGHT,
    borderRadius: Spacing.CHIP_HEIGHT / 2,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
  },
  genderButtonSelected: { borderColor: Colors.GREEN, backgroundColor: Colors.GREEN_LIGHT },
  genderText: { ...Typography.BODY, color: Colors.DARK },
  genderTextSelected: { color: Colors.GREEN_DARK, fontWeight: '600' },
  consentRow: { flexDirection: 'row', alignItems: 'center', marginVertical: Spacing.L },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: Colors.BORDER,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.M,
  },
  checkboxChecked: { backgroundColor: Colors.GREEN, borderColor: Colors.GREEN },
  checkmark: { color: Colors.WHITE, fontSize: 14, fontWeight: '700' },
  consentText: { ...Typography.CAPTION, color: Colors.DARK, flex: 1 },
  errorText: { ...Typography.ERROR, marginBottom: Spacing.M },
  primaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    backgroundColor: Colors.GREEN,
    borderRadius: Spacing.BUTTON_RADIUS,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { ...Typography.BUTTON_TEXT, color: Colors.WHITE },
  secondaryButton: {
    height: Spacing.BUTTON_HEIGHT_PRIMARY,
    borderRadius: Spacing.BUTTON_RADIUS,
    borderWidth: 1,
    borderColor: Colors.GREEN,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.M,
  },
  secondaryButtonText: { ...Typography.BUTTON_TEXT, color: Colors.GREEN },
  resultCard: {
    backgroundColor: Colors.LIGHT_GRAY,
    borderRadius: 12,
    padding: Spacing.L,
    marginBottom: Spacing.L,
  },
  resultName: { ...Typography.SECTION_HEADING, marginBottom: Spacing.M },
  resultRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.S },
  resultLabel: { ...Typography.BODY, color: Colors.GRAY },
  resultValue: { ...Typography.BODY, color: Colors.DARK, fontWeight: '600' },
  matchCard: {
    backgroundColor: Colors.WHITE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    padding: Spacing.L,
    marginBottom: Spacing.L,
  },
  matchTitle: { ...Typography.SECTION_HEADING, marginBottom: Spacing.M },
  matchRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.S },
  matchLabel: { ...Typography.BODY, color: Colors.DARK },
  matchIcon: { ...Typography.BODY, fontWeight: '600' },
  printDisclaimer: { ...Typography.CAPTION, color: Colors.GRAY, marginBottom: Spacing.L, fontStyle: 'italic' },
  stepLabel: { ...Typography.SECTION_HEADING, marginBottom: Spacing.M },
  tierRow: { flexDirection: 'row', gap: Spacing.M, marginBottom: Spacing.M },
  tierCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: 12,
    padding: Spacing.M,
    backgroundColor: Colors.WHITE,
  },
  tierCardSelected: { borderColor: Colors.GREEN, borderWidth: 2, backgroundColor: Colors.GREEN_10 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: Colors.BORDER,
    marginBottom: Spacing.S,
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioSelected: { borderColor: Colors.GREEN },
  radioDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: Colors.GREEN },
  tierName: { ...Typography.BODY, fontWeight: '700', color: Colors.DARK, marginBottom: 2 },
  tierValue: { ...Typography.CAPTION, color: Colors.GRAY, textDecorationLine: 'line-through' },
  freeNote: { ...Typography.CAPTION, color: Colors.GREEN, fontWeight: '600', marginBottom: Spacing.L, textAlign: 'center' },
  // Regular-tier on-screen preview
  regularPreview: {
    borderWidth: 1,
    borderColor: Colors.BORDER,
    borderRadius: 10,
    backgroundColor: '#f7f7f0',
    padding: Spacing.M,
    marginBottom: Spacing.M,
  },
  regularPreviewHeader: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 2, borderBottomColor: Colors.GREEN, paddingBottom: Spacing.S, marginBottom: Spacing.S },
  regularPreviewEmblem: { width: 36, height: 36, resizeMode: 'contain' },
  regularPreviewEmblemSpacer: { width: 36 },
  regularPreviewTitleBlock: { flex: 1, alignItems: 'center' },
  regularPreviewTitle: { ...Typography.BODY, fontWeight: '700', color: Colors.DARK, textAlign: 'center' },
  regularPreviewSub: { ...Typography.CAPTION, color: Colors.GRAY },
  regularPreviewBody: { flexDirection: 'row', justifyContent: 'space-between' },
  regularPreviewFields: { flex: 1 },
  regularPreviewField: { ...Typography.CAPTION, color: Colors.DARK, marginBottom: 4 },
  regularPreviewPhoto: { width: 64, height: 76, borderRadius: 4, marginLeft: Spacing.M },
  regularPreviewPhotoBlank: { width: 64, height: 76, borderRadius: 4, marginLeft: Spacing.M, backgroundColor: Colors.LIGHT_GRAY },
  // Standard/Premium-tier on-screen preview
  cardPreview: {
    borderWidth: 1,
    borderColor: '#cfe3d6',
    borderRadius: 12,
    padding: Spacing.M,
    backgroundColor: '#f4faf6',
    marginBottom: Spacing.M,
    position: 'relative',
    overflow: 'hidden',
  },
  cardPreviewPremium: { backgroundColor: Colors.GREEN_10, borderColor: Colors.GREEN },
  cardPreviewWatermark: { position: 'absolute', width: 180, height: 180, top: '50%', left: '50%', marginTop: -90, marginLeft: -90, opacity: 0.14, resizeMode: 'contain' },
  cardPreviewHeaderRow: { marginBottom: Spacing.S },
  cardPreviewBrandFed: { ...Typography.CAPTION, color: Colors.GREEN_DARK, fontWeight: '800' },
  cardPreviewBrandSub: { ...Typography.CAPTION, color: Colors.DARK, fontWeight: '800', letterSpacing: 0.5 },
  cardPreviewRow: { flexDirection: 'row' },
  cardPreviewPhoto: { width: 56, height: 68, borderRadius: 4, marginRight: Spacing.M },
  cardPreviewPhotoBlank: { width: 56, height: 68, borderRadius: 4, marginRight: Spacing.M, backgroundColor: Colors.LIGHT_GRAY },
  cardPreviewFields: { flex: 1 },
  cardPreviewLabel: { ...Typography.CAPTION, color: Colors.GRAY, fontSize: 9, marginTop: 4 },
  cardPreviewValue: { ...Typography.BODY, color: Colors.DARK, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  cardPreviewDobSexRow: { flexDirection: 'row', gap: Spacing.L },
  cardPreviewRightCol: { alignItems: 'flex-end', marginLeft: Spacing.S },
  cardPreviewNga: { ...Typography.HEADING, color: Colors.DARK, fontWeight: '800', letterSpacing: 1 },
  cardPreviewIssueLabel: { ...Typography.CAPTION, color: Colors.GRAY, fontSize: 8.5, marginTop: Spacing.S },
  cardPreviewIssueValue: { ...Typography.CAPTION, color: Colors.DARK, fontWeight: '700', fontSize: 10 },
  cardPreviewNinLabel: { ...Typography.CAPTION, color: Colors.GRAY, fontSize: 9, textAlign: 'center', marginTop: Spacing.M },
  cardPreviewNin: { ...Typography.HEADING, color: Colors.DARK, fontWeight: '800', letterSpacing: 3, textAlign: 'center' },
});
