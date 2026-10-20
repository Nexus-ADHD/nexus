import { ReactNode } from 'react';
import { Text, View } from 'react-native';
import tokens from '@/src/theme/tokens';

type Props = {
  title: string;
  subtitle?: string;
  children: ReactNode;
};

// FIXME(nex-56): this component appears to be a light-mode scaffold (uses light gray border ddd, no dark bg/text colors) — design review can either delete if unused or align with CLAUDE.md dark-mode tokens.
export function SectionCard({ title, subtitle, children }: Props) {
  return (
    <View
      style={{
        borderWidth: 1,
        // FIXME(nex-56): light-mode gray #ddd, no dark-mode token — design review
        borderColor: tokens.color.goldHairline,
        borderRadius: 16,
        padding: tokens.spacing.md,
        gap: tokens.spacing.sm,
      }}>
      <View>
        {/* FIXME(nex-56): off-scale 18pt fontSize — design review */}
        <Text style={{ fontSize: 18, fontWeight: '700' }}>{title}</Text>
        {subtitle ? (
          // FIXME(nex-56): off-scale 13pt fontSize — design review
          <Text style={{ fontSize: 13, marginTop: tokens.spacing.xxs, opacity: 0.7 }}>{subtitle}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}
