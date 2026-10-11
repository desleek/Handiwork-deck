import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../src/api/client';
import type { ChatMessage } from '../../../src/api/types';
import { PlatformIcon, T } from '../../../src/components/ui';
import { useMe } from '../../../src/lib/auth';
import { enqueueMessage, onOutboxChange, pendingFor } from '../../../src/lib/offline';
import { useTheme } from '../../../src/theme';

/**
 * Masked chat (Section 8). Messages queue locally while offline and send when back online.
 * Technician replies sent via WhatsApp appear here too, marked with a small WhatsApp label.
 */
export default function Chat() {
  const t = useTheme();
  const me = useMe();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const list = useRef<FlatList<ChatMessage>>(null);

  const { data = [] } = useQuery({
    queryKey: ['messages', id],
    queryFn: () => api<ChatMessage[]>(`/jobs/${id}/messages`),
    refetchInterval: 5_000,
  });

  useEffect(() => {
    const load = async () =>
      setPending((await pendingFor(id)).map((m) => ({ id: m.clientMsgId, sender_id: me.id, body: m.body, channel: 'app', redacted: false, created_at: m.createdAt, pending: true })));
    load();
    return onOutboxChange(load);
  }, [id, me.id]);

  const messages = [...data, ...pending.filter((p) => !data.some((d: any) => d.client_msg_id === p.id))];

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    await enqueueMessage(id, body);
    setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
  };

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: t.color.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <FlatList
          ref={list}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: t.space(4), gap: t.space(2) }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          ListHeaderComponent={<T v="tiny" muted style={{ textAlign: 'center', marginBottom: t.space(2) }}>Phone numbers and emails are hidden until the job is paid. Chat is kept as a record for disputes.</T>}
          renderItem={({ item }) => {
            const mine = item.sender_id === me.id;
            const system = item.sender_id === null;
            return (
              <View style={{ alignSelf: system ? 'center' : mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
                <View style={{ backgroundColor: system ? 'transparent' : mine ? t.color.primary : t.color.surface, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, opacity: item.pending ? 0.6 : 1 }}>
                  <T style={{ color: mine ? t.color.primaryText : t.color.text }}>{item.body}</T>
                </View>
                <T v="tiny" muted style={{ alignSelf: mine ? 'flex-end' : 'flex-start', marginTop: 2 }}>
                  {item.pending ? 'Sending…' : new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {item.channel === 'whatsapp' ? ' · via WhatsApp' : ''}
                  {item.redacted ? ' · contact details hidden' : ''}
                </T>
              </View>
            );
          }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: t.space(2), padding: t.space(3), backgroundColor: t.color.surface, borderTopWidth: 1, borderTopColor: t.color.border }}>
          <TextInput value={text} onChangeText={setText} multiline placeholder="Message" placeholderTextColor={t.color.textMuted} style={{ flex: 1, maxHeight: 120, color: t.color.text, backgroundColor: t.color.bg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 }} />
          <Pressable onPress={send} accessibilityLabel="Send" style={{ backgroundColor: t.color.primary, borderRadius: 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <PlatformIcon name="send" color={t.color.primaryText} size={20} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
