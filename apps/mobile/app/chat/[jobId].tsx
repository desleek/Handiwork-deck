import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, ErrorText, Muted } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Message {
  id: number;
  body: string;
  mine: boolean;
  channel: 'app' | 'whatsapp';
  masked: boolean;
  created_at: string;
}

/** Masked in-app chat for one (job, technician) thread; polls every 5 s. */
export default function Chat() {
  const { jobId, technicianId, name } = useLocalSearchParams<{ jobId: string; technicianId: string; name?: string }>();
  const { user } = useAuth();
  const navigation = useNavigation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const list = useRef<FlatList<Message>>(null);
  // Technicians don't pass technicianId for their own thread.
  const qs = user?.role === 'technician' ? '' : `?technicianId=${technicianId}`;

  useLayoutEffect(() => navigation.setOptions({ title: name ?? 'Chat' }), [navigation, name]);

  const load = useCallback(async () => {
    try {
      const r = await api<{ messages: Message[]; contactUnlocked: boolean; isOpen: boolean }>(`/jobs/${jobId}/messages${qs}`);
      setMessages(r.messages);
      setUnlocked(r.contactUnlocked);
      setOpen(r.isOpen);
    } catch (e) {
      setError(e);
    }
  }, [jobId, qs]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    try {
      const r = await api<{ message: Message }>(`/jobs/${jobId}/messages`, {
        body: { body, technicianId: user?.role === 'customer' ? technicianId : undefined },
      });
      setMessages((m) => [...m, r.message]);
    } catch (e) {
      setError(e);
      setText(body);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['left', 'right', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        {!unlocked && (
          <View style={{ backgroundColor: '#EEF0F3', padding: 10 }}>
            <Muted>🔒 Phone numbers and emails are hidden until a quote is approved. Messages also reach the other party via our WhatsApp number.</Muted>
          </View>
        )}
        <FlatList
          ref={list}
          data={messages}
          keyExtractor={(m) => String(m.id)}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={<Muted>No messages yet. Say hello!</Muted>}
          renderItem={({ item }) => (
            <View
              style={{
                alignSelf: item.mine ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                backgroundColor: item.mine ? colors.primary : '#fff',
                borderRadius: 14,
                padding: 10,
                borderWidth: item.mine ? 0 : 1,
                borderColor: colors.line,
              }}
            >
              <Text style={{ color: item.mine ? '#fff' : colors.ink }}>{item.body}</Text>
              <Text style={{ fontSize: 10, marginTop: 4, color: item.mine ? '#FFE3D3' : colors.muted }}>
                {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {item.channel === 'whatsapp' ? ' · via WhatsApp' : ''}
                {item.masked ? ' · contact hidden' : ''}
              </Text>
            </View>
          )}
        />
        <ErrorText error={error} />
        {open ? (
          <View style={{ flexDirection: 'row', gap: 8, padding: 10, borderTopWidth: 1, borderColor: colors.line, backgroundColor: '#fff' }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message"
              placeholderTextColor={colors.muted}
              style={{ flex: 1, borderWidth: 1, borderColor: colors.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, color: colors.ink }}
              multiline
            />
            <Pressable onPress={send} style={{ backgroundColor: colors.primary, borderRadius: 20, paddingHorizontal: 16, justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontWeight: '600' }}>Send</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ padding: 12 }}>
            <Muted>This conversation is closed.</Muted>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
