import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { Badge, Card, colors, ErrorText, Loading, Muted, Screen, styles } from '@/components/ui';
import { useApi } from '@/lib/useApi';

interface Thread {
  id: string;
  technician_name: string;
  customer_name: string;
  is_open: boolean;
  messages: { id: number; sender_role: string | null; body: string; original_body: string | null; masked: boolean; channel: string; created_at: string }[];
}

/** Section 8: admin-only full chat log for disputes, including the unmasked original of each message. */
export default function ChatLog() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading } = useApi<{ threads: Thread[] }>(`/admin/jobs/${id}/messages`);
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.threads.length === 0 && <Muted>No conversations on this job.</Muted>}
      {data?.threads.map((t) => (
        <Card key={t.id}>
          <Text style={styles.label}>
            {t.customer_name} ↔ {t.technician_name} {t.is_open ? '' : '(closed)'}
          </Text>
          {t.messages.map((m) => (
            <View key={m.id} style={{ gap: 2, borderTopWidth: 1, borderColor: colors.line, paddingTop: 4 }}>
              <View style={styles.row}>
                <Muted>
                  {new Date(m.created_at).toLocaleString()} · {m.sender_role ?? 'system'} · {m.channel}
                </Muted>
                {m.masked && <Badge label="masked for parties" tone="warn" />}
              </View>
              <Text style={{ color: colors.ink }}>{m.original_body ?? m.body}</Text>
              {m.masked && <Muted>Shown as: {m.body}</Muted>}
            </View>
          ))}
        </Card>
      ))}
    </Screen>
  );
}
