import { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

type Props = {
  eyebrow?: string;
  title: string;
  description?: string;
  rightSlot?: ReactNode;
  children: ReactNode;
};

export function ScreenShell({ eyebrow, title, description, rightSlot, children }: Props) {
  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            {eyebrow ? (
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 12, fontWeight: '600', opacity: 0.7 }}>{eyebrow}</Text>
            ) : null}
            <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 34, fontWeight: '700' }}>{title}</Text>
            {description ? (
              <Text style={{ /* FIXME(nex-56): inline fontSize literal — design review */ fontSize: 15, marginTop: 4, opacity: 0.8 }}>{description}</Text>
            ) : null}
          </View>
          {rightSlot}
        </View>
      </View>
      {children}
    </ScrollView>
  );
}
