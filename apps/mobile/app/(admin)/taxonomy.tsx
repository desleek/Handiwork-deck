import Ionicons from '@expo/vector-icons/Ionicons';
import { SERVICE_SEGMENTS, type ServiceSegment } from '@handiwork/shared';
import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { type Category, iconFor, SEGMENT_LABEL } from '@/lib/categories';
import { useApi } from '@/lib/useApi';

interface AdminCategory extends Category {
  is_active: boolean;
  sort_order: number;
  technician_count: number;
  job_count: number;
}
interface Suggestion {
  id: string;
  name: string;
  segment: ServiceSegment;
  note: string | null;
  suggested_by_name: string;
  suggested_by_role: string;
  job_ref: string | null;
}

/** Section 2: the taxonomy is edited here — nothing is hard-coded in the app. */
export default function Taxonomy() {
  const cats = useApi<{ categories: AdminCategory[] }>('/admin/categories');
  const sugg = useApi<{ suggestions: Suggestion[] }>('/admin/category-suggestions');
  const [segment, setSegment] = useState<ServiceSegment>('household_office');
  const [editing, setEditing] = useState<AdminCategory | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (cats.loading && !cats.data) return <Loading />;
  const list = cats.data?.categories.filter((c) => c.segment === segment) ?? [];
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([cats.reload(), sugg.reload()]);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Screen>
      {!!sugg.data?.suggestions.length && (
        <>
          <Text style={styles.label}>Custom requests awaiting approval</Text>
          {sugg.data.suggestions.map((s) => (
            <SuggestionCard key={s.id} s={s} categories={cats.data?.categories ?? []} onDone={() => run(async () => {})} />
          ))}
        </>
      )}

      <View style={styles.row}>
        {SERVICE_SEGMENTS.map((s) => (
          <Chip key={s} label={SEGMENT_LABEL[s]} selected={segment === s} onPress={() => setSegment(s)} />
        ))}
      </View>
      <Button title="Add category" onPress={() => setEditing('new')} />
      {editing && (
        <CategoryForm
          initial={editing === 'new' ? null : editing}
          segment={segment}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void run(async () => {});
          }}
        />
      )}
      <ErrorText error={error} />
      {list.map((c) => (
        <Card key={c.id} onPress={() => setEditing(c)} style={c.is_active ? undefined : { opacity: 0.55 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Ionicons name={iconFor(c.icon)} size={22} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '600', color: colors.ink }}>{c.name}</Text>
              <Muted>
                {c.technician_count} technicians · {c.job_count} jobs{c.is_other ? ' · catch-all' : ''}
              </Muted>
            </View>
            <Switch
              value={c.is_active}
              onValueChange={(v) => run(() => api(`/admin/categories/${c.id}`, { method: 'PATCH', body: { isActive: v } }))}
              accessibilityLabel={`${c.name} active`}
            />
          </View>
        </Card>
      ))}
    </Screen>
  );
}

function CategoryForm({ initial, segment, onCancel, onSaved }: { initial: AdminCategory | null; segment: ServiceSegment; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [seg, setSeg] = useState<ServiceSegment>(initial?.segment ?? segment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), icon: icon.trim() || undefined, description: description.trim() || undefined, segment: seg };
      if (initial) await api(`/admin/categories/${initial.id}`, { method: 'PATCH', body });
      else await api('/admin/categories', { body });
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ borderColor: colors.primary }}>
      <Text style={styles.label}>{initial ? `Edit ${initial.name}` : 'New category'}</Text>
      <Field label="Name" value={name} onChangeText={setName} />
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Field label="Icon (Ionicons name)" value={icon} onChangeText={setIcon} autoCapitalize="none" placeholder="e.g. hammer" />
        </View>
        <Ionicons name={iconFor(icon)} size={32} color={colors.primary} style={{ paddingBottom: 6 }} />
      </View>
      <Field label="Description" value={description} onChangeText={setDescription} multiline />
      <View style={styles.row}>
        {SERVICE_SEGMENTS.map((s) => (
          <Chip key={s} label={SEGMENT_LABEL[s]} selected={seg === s} onPress={() => setSeg(s)} />
        ))}
      </View>
      <Button title="Save" loading={busy} disabled={name.trim().length < 2} onPress={save} />
      <Button title="Cancel" variant="secondary" onPress={onCancel} />
      <ErrorText error={error} />
    </Card>
  );
}

function SuggestionCard({ s, categories, onDone }: { s: Suggestion; categories: AdminCategory[]; onDone: () => void }) {
  const [name, setName] = useState(s.name);
  const [mapTo, setMapTo] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const act = async (path: string, body: object) => {
    setError(null);
    try {
      await api(`/admin/category-suggestions/${s.id}/${path}`, { body });
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  const existing = categories.filter((c) => c.segment === s.segment && c.is_active && !c.is_other);
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontWeight: '700' }}>{s.name}</Text>
        <Badge label={s.job_ref ? `Job #${s.job_ref}` : s.suggested_by_role} />
      </View>
      <Muted>
        {SEGMENT_LABEL[s.segment]} · from {s.suggested_by_name}
      </Muted>
      {s.note ? <Text>{s.note}</Text> : null}
      <Field label="Create as" value={name} onChangeText={setName} />
      <Button title="Approve as new category" onPress={() => act('approve', { name: name.trim() })} />
      <Muted>…or file it under an existing category:</Muted>
      <View style={styles.row}>
        {existing.slice(0, 30).map((c) => (
          <Chip key={c.id} label={c.name} selected={mapTo === c.id} onPress={() => setMapTo(c.id)} />
        ))}
      </View>
      {mapTo && <Button title="Approve into selected category" variant="secondary" onPress={() => act('approve', { existingCategoryId: mapTo })} />}
      <Button title="Reject (job goes out under “Other”)" variant="secondary" onPress={() => act('reject', {})} />
      <ErrorText error={error} />
    </Card>
  );
}
