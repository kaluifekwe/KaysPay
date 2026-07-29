import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '../constants/colors';
import { Typography } from '../constants/typography';
import { Spacing } from '../constants/spacing';

// TEMPORARY (2026-07-06): owner has no dedicated support inbox yet and
// asked to use a placeholder until one exists — this is the ONE place it's
// defined, so updating it later means changing it here only. MUST be
// replaced with a real, monitored address before this app is submitted to
// the Play Store — a support/contact email that doesn't actually work is a
// real problem for privacy-rights requests (data access/deletion), not
// just a formality.
export const SUPPORT_EMAIL = 'support@kayspay.com.ng';

const LAST_UPDATED = '6 July 2026';


function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Para({ children }: { children: React.ReactNode }) {
  return <Text style={styles.paragraph}>{children}</Text>;
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletDot}>{'•'}</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

function PrivacyPolicyContent() {
  return (
    <>
      <Para>
        KaysPay ("we", "us", "our") provides a mobile app for buying airtime, data, bills, exam pins,
        foreign phone numbers, eSIMs, verifying NIN/BVN
        details, and funding/withdrawing from an in-app wallet. This policy explains what information
        we collect, why, and how it's protected.
      </Para>

      <Section title="1. Information We Collect">
        <Para>To provide these services, we collect:</Para>
        <Bullet>Account details: full name, email address, phone number.</Bullet>
        <Bullet>A PIN you set for authorizing transactions — stored only as a secure hash, never in
          plain text; biometric unlock data never leaves your device.</Bullet>
        <Bullet>Transaction records: what you bought, amounts, recipients' phone numbers, timestamps,
          and status.</Bullet>
        <Bullet>NIN or BVN numbers, and the identity details returned by verifying them (name, date of
          birth, gender, phone number, and photo on file), only when you use the NIN/BVN Services or
          bank-transfer wallet funding features and only for that purpose.</Bullet>
        <Bullet>Contacts on your device, only if you grant permission and only to let you pick
          recipients for bulk airtime/data sends — we do not upload your full address book
          anywhere.</Bullet>
        <Bullet>A profile photo, if you choose to upload one.</Bullet>
        <Bullet>Basic technical information needed to operate the app reliably (device type,
          app version, and error logs).</Bullet>
      </Section>

      <Section title="2. How We Use Your Information">
        <Bullet>To process the purchases and transfers you request, and to credit/debit your wallet
          accordingly.</Bullet>
        <Bullet>To verify your identity where required (e.g. bank-transfer wallet funding, NIN/BVN
          verification services), consistent with Nigerian KYC requirements.</Bullet>
        <Bullet>To detect and prevent fraud, and to investigate disputed transactions.</Bullet>
        <Bullet>To provide customer support when you contact us.</Bullet>
        <Bullet>To show you your own transaction history and account details within the app.</Bullet>
      </Section>

      <Section title="3. Who We Share Information With">
        <Para>
          We never sell your personal information. We share only what's necessary, with the specific
          providers required to fulfil the service you requested:
        </Para>
        <Bullet>Payment processors (Flutterwave) — for wallet funding and bank
          account verification.</Bullet>
        <Bullet>Airtime/data/bills/exam-pin providers (VTU.ng, VTUAfrica) — to deliver the
          specific product you purchased to the recipient number you provide.</Bullet>
        <Bullet>Identity verification providers (Prembly, CheckMyNINBVN) — only when you use NIN/BVN
          verification or update services, to check your NIN/BVN against official records.</Bullet>
        <Bullet>Foreign number and eSIM providers (GrizzlySMS, Airalo) — to deliver those
          specific services.</Bullet>
        <Bullet>Regulators or law enforcement, only where legally required to do so.</Bullet>
        <Para>
          These providers only receive the minimum information needed to complete your specific
          request — for example, an airtime provider never sees your NIN, and a NIN verification
          provider never sees your transaction history.
        </Para>
      </Section>

      <Section title="4. Data Retention">
        <Para>
          We keep your account and transaction records for as long as your account is active, and
          afterward for as long as Nigerian financial recordkeeping and tax regulations require. NIN/BVN
          verification results are cached for 24 hours to avoid re-charging you for repeat checks, then
          only the historical transaction record remains.
        </Para>
      </Section>

      <Section title="5. Your Rights">
        <Para>
          You can ask us to access, correct, or delete your personal information, or ask questions
          about how it's used, by contacting us at {SUPPORT_EMAIL}. Some information (such as completed
          transaction records) may need to be retained even after a deletion request, where required by
          Nigerian financial regulation.
        </Para>
      </Section>

      <Section title="6. Security">
        <Para>
          Passwords and PINs are never stored in plain text. Every transaction requires a fresh PIN or
          biometric confirmation. Wallet balances and provider credentials are handled entirely on our
          servers — the app itself never has direct access to move money without that step-up
          confirmation. No method of transmission or storage is 100% secure, but we apply
          industry-standard practices throughout.
        </Para>
      </Section>

      <Section title="7. Children's Privacy">
        <Para>
          KaysPay is a financial service intended for users who are at least 18 years old. We do not
          knowingly collect information from anyone under 18.
        </Para>
      </Section>

      <Section title="8. Changes to This Policy">
        <Para>
          We may update this policy as the app's features change. Material changes will be reflected
          with a new "Last updated" date below, and significant changes will be highlighted in the app.
        </Para>
      </Section>

      <Section title="9. Contact Us">
        <Para>
          Questions about this policy or your data can be sent to {SUPPORT_EMAIL}.
        </Para>
      </Section>
    </>
  );
}

function TermsOfServiceContent() {
  return (
    <>
      <Para>
        These Terms of Service ("Terms") govern your use of the KaysPay app. By creating an account or
        using the app, you agree to these Terms.
      </Para>

      <Section title="1. Eligibility">
        <Para>
          You must be at least 18 years old and legally capable of entering into binding contracts in
          Nigeria to use KaysPay. You are responsible for providing accurate registration information
          and for keeping your PIN and device secure.
        </Para>
      </Section>

      <Section title="2. Our Services">
        <Para>KaysPay lets you, subject to available balance and provider availability:</Para>
        <Bullet>Buy airtime, data bundles, TV subscriptions, electricity, and exam pins.</Bullet>
        <Bullet>Fund foreign/virtual phone numbers.</Bullet>
        <Bullet>Purchase travel eSIMs.</Bullet>
        <Bullet>Verify NIN/BVN details, and submit NIN correction requests to NIMC via our provider.</Bullet>
        <Bullet>Fund your in-app wallet and withdraw to a linked bank account.</Bullet>
      </Section>

      <Section title="3. Wallet, Fees, and Charges">
        <Para>
          Your wallet balance reflects funds you have added, minus completed purchases, plus any
          refunds. Where a purchase includes a service fee, the fee is
          shown to you before you confirm. Prices for identity verification and NIN update services are
          shown before you confirm and may change from time to time.
        </Para>
      </Section>

      <Section title="4. Failed Transactions and Refunds">
        <Para>
          If a purchase cannot be completed by the provider, the amount debited for that specific
          purchase is automatically refunded to your wallet — you do not need to request it. Reviewed
          orders (such as NIN validation/correction requests) that are rejected by NIMC are refunded
          once the rejection is confirmed. You can see the outcome and reason for any transaction
          in your Transaction History.
        </Para>
      </Section>

      <Section title="5. Your Responsibilities">
        <Bullet>Provide accurate recipient details (phone numbers, account numbers, NIN/BVN) — we are
          not responsible for funds sent to a recipient number you entered incorrectly.</Bullet>
        <Bullet>Keep your PIN, device, and biometric access secure. You are responsible for
          transactions authorized from your account.</Bullet>
        <Bullet>Use the app only for lawful purposes. You may not use KaysPay for fraud, money
          laundering, or to circumvent any provider's or regulator's rules.</Bullet>
      </Section>

      <Section title="6. Service Availability">
        <Para>
          We work with third-party providers (banks, telecoms, identity verification services) to
          deliver these features, and their availability is not entirely within our control. We aim for
          reliable service but do not guarantee uninterrupted access, and we are not liable for delays
          or failures caused by a third-party provider, provided any resulting debit is refunded as
          described above.
        </Para>
      </Section>

      <Section title="7. Account Suspension">
        <Para>
          We may suspend or close an account that we reasonably believe is being used fraudulently, for
          money laundering, or in violation of these Terms, and may report such activity to relevant
          authorities as required by law.
        </Para>
      </Section>

      <Section title="8. Limitation of Liability">
        <Para>
          To the extent permitted by Nigerian law, KaysPay is not liable for indirect or consequential
          losses arising from use of the app, except where such loss results from our own fraud or
          gross negligence.
        </Para>
      </Section>

      <Section title="9. Governing Law">
        <Para>
          These Terms are governed by the laws of the Federal Republic of Nigeria. Any dispute will
          first be addressed through our customer support channel before other resolution steps.
        </Para>
      </Section>

      <Section title="10. Changes to These Terms">
        <Para>
          We may update these Terms as our services evolve. Continued use of the app after an update
          means you accept the revised Terms.
        </Para>
      </Section>

      <Section title="11. Contact Us">
        <Para>
          Questions about these Terms can be sent to {SUPPORT_EMAIL}.
        </Para>
      </Section>
    </>
  );
}

export default function LegalDocumentScreen(props: any) {
  const { navigation, route } = props;
  const isPrivacy = route.params.type === 'privacy';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isPrivacy ? 'Privacy Policy' : 'Terms of Service'}</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.docTitle}>{isPrivacy ? 'Privacy Policy' : 'Terms of Service'}</Text>
        <Text style={styles.lastUpdated}>Last updated: {LAST_UPDATED}</Text>

        {isPrivacy ? <PrivacyPolicyContent /> : <TermsOfServiceContent />}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.WHITE },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.SCREEN_PADDING,
    paddingVertical: Spacing.S,
    borderBottomWidth: 1,
    borderBottomColor: Colors.BORDER,
  },
  backButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  backText: { fontSize: 24, fontWeight: '600', color: Colors.DARK },
  headerTitle: { ...Typography.SECTION_HEADING, color: Colors.DARK },
  scrollContent: { paddingHorizontal: Spacing.SCREEN_PADDING, paddingTop: Spacing.L, paddingBottom: Spacing.XL },
  docTitle: { ...Typography.SCREEN_TITLE, color: Colors.DARK, marginBottom: 4 },
  lastUpdated: { ...Typography.CAPTION, color: Colors.GRAY, marginBottom: Spacing.L },
  section: { marginTop: Spacing.L },
  sectionTitle: { ...Typography.SECTION_HEADING, color: Colors.DARK, marginBottom: Spacing.S },
  paragraph: { ...Typography.BODY, color: Colors.DARK, lineHeight: 21, marginBottom: Spacing.S },
  bulletRow: { flexDirection: 'row', marginBottom: Spacing.S, paddingRight: Spacing.S },
  bulletDot: { ...Typography.BODY, color: Colors.DARK, marginRight: Spacing.S },
  bulletText: { ...Typography.BODY, color: Colors.DARK, lineHeight: 21, flex: 1 },
});
