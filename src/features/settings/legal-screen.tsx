import React from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, Platform, Linking } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import tokens from '@/src/theme/tokens';

const PRIVACY_SECTIONS = [
  {
    title: '1. Information We Collect',
    content: [
      { label: 'Account Information:', text: 'When you create an account, we collect your email address and display name through our authentication provider (Supabase Auth).' },
      { label: 'Phone Number:', text: 'If you choose to add a phone number, we store it to support your account and optional future SMS features. We will not send you SMS messages without your separate, explicit consent.' },
      { label: 'User-Generated Content:', text: 'We store data you create within the app, including tasks, habits, calendar events, journal entries, mandates, and daily scores. This data is stored on your device and, if you enable cloud sync, on our servers.' },
      { label: 'Voice Data:', text: 'When you speak to Nexus, the recording is uploaded to OpenAI through our secure proxy and transcribed there. Live on-device speech recognition runs alongside it to show you words as you speak, and is used as a fallback if the upload fails, but the uploaded audio is the primary transcription path. We do not store raw audio recordings after transcription is complete.' },
      { label: 'Install Attribution:', text: 'On iOS we ask Apple for an Apple Search Ads attribution token and pass it to RevenueCat, so we can tell which ads bring people to Nexus. This does not use the advertising identifier and does not track you across other apps or websites.' },
      { label: 'Usage and Analytics Data:', text: 'We use PostHog to collect product-analytics events, such as screens viewed, in-app interactions, and app open and close, linked to a pseudonymous account identifier. This data is not anonymous. We never send your habits, mandates, reflections, or other personal content for analytics.' },
      { label: 'Connected Calendars:', text: 'If you connect a Google or Microsoft calendar, we read your event details and store the account email and display name on your device so you can tell the accounts apart. To map your goals onto your real week, the titles of your recent events are sent to our AI provider through the secure proxy. Event notes and locations are not sent.' },
      { label: 'Connected Recording Services:', text: 'If you connect a PLAUD account, Nexus reads the transcript text of recordings you select, one at a time. We never request, download, or store audio. Your PLAUD sign-in tokens are kept in the iOS Keychain on your device and are never sent to our servers. Nexus does not keep the full transcript. It saves the proposals, which recording they came from, and a short word-for-word excerpt behind each proposal so you can check it against what you actually said. Those stay on your device and are not synced to our servers. Tasks you approve are then stored like anything else you create in the app.' },
    ],
  },
  {
    title: '2. How We Use Your Information',
    list: [
      "To provide and maintain the app's core functionality",
      'To sync your data across devices when you enable cloud backup',
      'To generate AI-powered insights, briefings, and recommendations',
      'To turn a recording you select from a connected service into proposals you review before anything is saved',
      'To send scheduled notifications and weekly email summaries (if enabled)',
      'To process subscription payments through RevenueCat',
      'To measure product usage so we can improve the app',
    ],
  },
  {
    title: '3. Third-Party Services',
    intro: 'We share data with, or read data from, the following third-party services only as needed to provide the app:',
    list: [
      'Supabase: Authentication and cloud data storage',
      'OpenAI, Anthropic, and Moonshot: AI text generation, and voice transcription at OpenAI. All of it is accessed through our secure proxy, which routes a request to whichever provider serves the model in use. Text you ask Nexus to interpret, including a transcript imported from a connected recording service, is sent to that provider to produce the result. It is not retained by Nexus.',
      'PostHog: Product analytics (usage events tied to a pseudonymous identifier)',
      'Braintrust: Aggregated monitoring of AI quality. We do not send your personal content.',
      'RevenueCat: Subscription management and payment processing, and Apple Search Ads install attribution',
      'Twilio: Delivery of text messages, if you turn them on. Receives your phone number and the message.',
      'Resend: Delivery of email such as the welcome note and weekly summary. Receives your email address and the message.',
      'Apple Calendar: Calendar access with your permission',
      'PLAUD: If you connect it, we read transcripts of recordings you choose. Never audio. You can disconnect at any time, which deletes the sign-in tokens stored on your device.',
      'Expo Push Notifications: Delivery of scheduled reminders',
    ],
  },
  {
    title: '4. Data Storage and Security',
    text: "Your data is stored on your device and, if you enable cloud sync, on Supabase's encrypted cloud infrastructure. We use industry-standard security measures to protect your information.",
  },
  {
    title: '5. Your Rights and Choices',
    text: 'You can request to access, export, correct, or delete your personal data, and opt out of usage analytics, by contacting us at admin@thecircleoflight.net. We will respond within a reasonable time.',
  },
  {
    title: '6. Data Retention and Deletion',
    text: 'We retain your information for as long as your account is active. To delete your account and all associated data, contact us at admin@thecircleoflight.net and we will remove it from our systems and our service providers, except where we are required to retain it by law. You can also clear local data by uninstalling the app.',
  },
  {
    title: '7. Selling of Data',
    text: 'We do not sell your personal information, and we do not share it with advertisers or data brokers.',
  },
  {
    title: "8. Children's Privacy",
    text: 'Nexus is not intended for use by children under 13. We do not knowingly collect personal information from children.',
  },
  {
    title: '9. Changes to This Policy',
    text: 'We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new policy within the app and updating the date above.',
  },
  {
    title: '10. Contact Us',
    text: 'If you have questions about this Privacy Policy, contact us at admin@thecircleoflight.net.',
  },
];

const TERMS_SECTIONS = [
  {
    title: '1. Acceptance of Terms',
    text: 'By accessing or using Nexus, you agree to be bound by these Terms. If you do not agree, do not use the app.',
  },
  {
    title: '2. Description of Service',
    text: 'Nexus is a personal productivity application that provides task management, habit tracking, calendar integration, and AI-powered insights. Features may change or be updated over time.',
  },
  {
    title: '3. User Accounts',
    text: 'You are responsible for maintaining the confidentiality of your account credentials. You agree to provide accurate information and to update it as necessary. You are responsible for all activities that occur under your account.',
  },
  {
    title: '4. Subscriptions and Payments',
    intro: 'Some features of Nexus require a paid subscription ("Nexus Pro"). Subscriptions are managed through the Apple App Store and processed by RevenueCat. All payments are subject to the terms of the applicable app store.',
    list: [
      'Subscriptions automatically renew unless cancelled at least 24 hours before the end of the current period.',
      "You can manage or cancel your subscription through your device's app store settings.",
      'Refunds are handled by Apple in accordance with their refund policies.',
    ],
  },
  {
    title: '5. User Content',
    text: 'You retain ownership of all content you create within Nexus (tasks, habits, journal entries, etc.). By using cloud sync, you grant us a limited license to store and transmit your content for the purpose of providing the service.',
  },
  {
    title: '6. AI Features',
    text: 'Nexus uses artificial intelligence (OpenAI) to provide insights, parse commands, and generate recommendations. AI-generated content is provided for informational purposes only and should not be relied upon as professional advice. We are not responsible for the accuracy of AI-generated content.',
  },
  {
    title: '7. Prohibited Uses',
    intro: 'You agree not to:',
    list: [
      'Use the app for any unlawful purpose',
      'Attempt to reverse engineer or modify the app',
      "Interfere with the app's operation or security",
      'Share your account credentials with others',
    ],
  },
  {
    title: '8. Limitation of Liability',
    text: 'Nexus is provided "as is" without warranties of any kind. We shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the app. Our total liability shall not exceed the amount you paid for the service in the past 12 months.',
  },
  {
    title: '9. Termination',
    text: 'We reserve the right to suspend or terminate your account at any time for violation of these Terms. You may delete your account at any time by contacting us at admin@thecircleoflight.net.',
  },
  {
    title: '10. Changes to Terms',
    text: 'We may modify these Terms at any time. Continued use of the app after changes constitutes acceptance of the new Terms.',
  },
  {
    title: '11. Governing Law',
    text: 'These Terms shall be governed by the laws of the United States, without regard to conflict of law principles.',
  },
  {
    title: '12. Contact',
    text: 'For questions about these Terms, contact us at admin@thecircleoflight.net.',
  },
];

const CONTACT_EMAIL = 'admin@thecircleoflight.net';

// PR #72 nit (Greptile): the contact email in the policy was non-tappable
// text. Split any body string on the email and render that segment as a
// nested tappable Text that opens Mail. React Native supports onPress on
// nested <Text>.
function renderBodyText(text: string) {
  if (!text.includes(CONTACT_EMAIL)) {
    return <Text style={styles.bodyText}>{text}</Text>;
  }
  const parts = text.split(CONTACT_EMAIL);
  return (
    <Text style={styles.bodyText}>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <Text
              style={styles.link}
              onPress={() => Linking.openURL(`mailto:${CONTACT_EMAIL}`)}
            >
              {CONTACT_EMAIL}
            </Text>
          )}
        </React.Fragment>
      ))}
    </Text>
  );
}

function renderSection(section: any, idx: number) {
  return (
    <View key={idx} style={styles.section}>
      <Text style={styles.sectionTitle}>{section.title}</Text>
      {section.intro && <Text style={styles.bodyText}>{section.intro}</Text>}
      {section.text && renderBodyText(section.text)}
      {section.content?.map((item: any, i: number) => (
        <Text key={i} style={styles.bodyText}>
          <Text style={styles.bold}>{item.label} </Text>
          {item.text}
        </Text>
      ))}
      {section.list?.map((item: string, i: number) => (
        <View key={i} style={styles.listItem}>
          <Text style={styles.bullet}>•</Text>
          <Text style={styles.listText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export default function LegalScreen() {
  const router = useRouter();
  const { type } = useLocalSearchParams<{ type: string }>();
  const insets = useSafeAreaInsets();
  const isPrivacy = type === 'privacy';
  const title = isPrivacy ? 'Privacy Policy' : 'Terms of Service';
  const sections = isPrivacy ? PRIVACY_SECTIONS : TERMS_SECTIONS;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={28} color={tokens.color.gold} />
        </Pressable>
        <Text style={styles.headerTitle}>{title}</Text>
        <View style={{ width: 28 }} />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.pageTitle}>{title}</Text>
        <Text style={styles.date}>Last updated: August 15, 2026</Text>
        {isPrivacy && (
          <Text style={styles.bodyText}>
            Nexus ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our mobile application.
          </Text>
        )}
        {!isPrivacy && (
          <Text style={styles.bodyText}>
            Welcome to Nexus. By using our mobile application, you agree to these Terms of Service. Please read them carefully.
          </Text>
        )}
        {sections.map(renderSection)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: tokens.color.void },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: tokens.color.surfaceElevated,
  },
  // FIXME(nex-56): off-scale 17pt fontSize, design review (nearest bodyLg 17pt — but weight 700 differs)
  headerTitle: { color: tokens.color.gold, fontSize: 17, fontWeight: '700', letterSpacing: 1 },
  scroll: { flex: 1 },
  // FIXME(nex-56): off-scale 60pt paddingBottom, design review
  scrollContent: { padding: tokens.spacing.lg, paddingBottom: 60 },
  // FIXME(nex-56): off-scale 24pt fontSize, design review
  pageTitle: { color: tokens.color.gold, fontSize: 24, fontWeight: '700', letterSpacing: 2, marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale gray, design review
  // FIXME(nex-56): off-scale 12pt fontSize, design review
  date: { color: tokens.color.textMuted, fontSize: 12, marginBottom: tokens.spacing.lg },
  // FIXME(nex-56): off-scale 28pt margin, design review (nearest xl 32pt)
  section: { marginTop: 28 },
  // FIXME(nex-56): off-scale 16pt fontSize, design review (matches buttonPrimary 16pt but weight/family differ)
  sectionTitle: { color: tokens.color.gold, fontSize: 16, fontWeight: '600', letterSpacing: 1, marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): off-scale gray, design review
  // FIXME(nex-56): off-scale 14pt fontSize, design review
  bodyText: { color: tokens.color.textSecondary, fontSize: 14, lineHeight: 22, marginBottom: tokens.spacing.sm },
  // FIXME(nex-56): off-scale gray, design review
  bold: { fontWeight: '700', color: tokens.color.text },
  link: { color: tokens.color.gold, textDecorationLine: 'underline' },
  listItem: { flexDirection: 'row', paddingLeft: tokens.spacing.xs, marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale 14pt fontSize, design review
  // FIXME(nex-56): off-scale 1pt top margin, design review
  bullet: { color: tokens.color.gold, fontSize: 14, marginRight: tokens.spacing.xs, marginTop: 1 },
  // FIXME(nex-56): off-scale gray, design review
  // FIXME(nex-56): off-scale 14pt fontSize, design review
  listText: { color: tokens.color.textSecondary, fontSize: 14, lineHeight: 22, flex: 1 },
});
