import { useMutation, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';
import { api, ApiError, uploadFile } from '../../src/api/client';
import { Banner, Button, Card, Row, Screen, T } from '../../src/components/ui';
import { toMinor } from '../../src/lib/money';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

interface TierDraft {
  minQty: string;
  price: string;
  technicianOnly: boolean;
}

/** Add / edit a storefront product, including bulk tiers and technician-only bulk discounts. */
export default function ProductEditor() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const all = useQuery({ queryKey: ['seller-products'], queryFn: () => api<any[]>('/seller/products'), enabled: !!id });
  const existing = all.data?.find((p) => p.id === id);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState('each');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('');
  const [active, setActive] = useState(true);
  const [images, setImages] = useState<string[]>([]);
  const [tiers, setTiers] = useState<TierDraft[]>([]);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? '');
    setUnit(existing.unit);
    setPrice(String(existing.price_minor / 100));
    setStock(existing.stock_qty === null ? '' : String(existing.stock_qty));
    setActive(existing.is_active);
    setImages(existing.image_urls ?? []);
    setTiers((existing.bulk_tiers ?? []).map((x: any) => ({ minQty: String(x.minQty), price: String(x.unitPriceMinor / 100), technicianOnly: x.audience === 'technician' })));
  }, [existing?.id]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        unit: unit.trim() || 'each',
        priceMinor: toMinor(price),
        stockQty: stock.trim() === '' ? null : Number(stock),
        isActive: active,
        imageUrls: images,
        bulkTiers: tiers
          .filter((x) => x.minQty && x.price)
          .map((x) => ({ minQty: Number(x.minQty), unitPriceMinor: toMinor(x.price), audience: x.technicianOnly ? 'technician' : 'all' })),
      };
      return id ? api(`/seller/products/${id}`, { method: 'PATCH', body }) : api('/seller/products', { body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seller-products'] });
      router.back();
    },
    onError: (e: ApiError) => Alert.alert('Not saved', e.message),
  });

  const addImage = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (r.canceled) return;
    const a = r.assets[0];
    try {
      const url = await uploadFile('product', { uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg', size: a.fileSize ?? 2_000_000, name: a.fileName ?? 'product.jpg' });
      setImages((x) => [...x, url]);
    } catch (e: any) {
      Alert.alert('Upload failed', e.message);
    }
  };

  const input = { backgroundColor: t.color.surface, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };
  return (
    <Screen>
      {id ? <Banner tone="info" text="Changing the name, description or photos sends the listing back for a quick review. Price and stock changes go live immediately." /> : null}
      <TextInput value={name} onChangeText={setName} placeholder="Product name (e.g. Dangote cement 50kg)" placeholderTextColor={t.color.textMuted} style={input} />
      <TextInput value={description} onChangeText={setDescription} multiline placeholder="Description, specs, brand" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 80 }]} />
      <Row>
        <View style={{ flex: 1 }}>
          <T v="tiny" muted>Price (₦)</T>
          <TextInput value={price} onChangeText={setPrice} keyboardType="decimal-pad" style={input} />
        </View>
        <View style={{ width: 90 }}>
          <T v="tiny" muted>Unit</T>
          <TextInput value={unit} onChangeText={setUnit} placeholder="bag" placeholderTextColor={t.color.textMuted} style={input} />
        </View>
        <View style={{ width: 90 }}>
          <T v="tiny" muted>Stock</T>
          <TextInput value={stock} onChangeText={setStock} keyboardType="number-pad" placeholder="∞" placeholderTextColor={t.color.textMuted} style={input} />
        </View>
      </Row>

      <Card>
        <T v="heading">Photos</T>
        <ScrollView horizontal contentContainerStyle={{ gap: t.space(2) }}>
          {images.map((u) => (
            <Pressable key={u} onLongPress={() => setImages((x) => x.filter((y) => y !== u))}>
              <Image source={{ uri: u }} style={{ width: 90, height: 90, borderRadius: t.radius.sm }} />
            </Pressable>
          ))}
        </ScrollView>
        {images.length < 6 ? <Button title="Add photo" kind="secondary" onPress={addImage} /> : null}
        <T v="tiny" muted>Long-press a photo to remove it.</T>
      </Card>

      <Card>
        <T v="heading">Bulk prices</T>
        <T v="small" muted>Lower prices for larger quantities. Mark a tier "technicians only" to offer trade discounts to verified pros.</T>
        {tiers.map((x, i) => (
          <View key={i} style={{ gap: 4 }}>
            <Row>
              <TextInput value={x.minQty} onChangeText={(v) => setTiers((ts) => ts.map((y, j) => (j === i ? { ...y, minQty: v } : y)))} keyboardType="number-pad" placeholder="Min qty" placeholderTextColor={t.color.textMuted} style={[input, { width: 90 }]} />
              <TextInput value={x.price} onChangeText={(v) => setTiers((ts) => ts.map((y, j) => (j === i ? { ...y, price: v } : y)))} keyboardType="decimal-pad" placeholder="Price each (₦)" placeholderTextColor={t.color.textMuted} style={[input, { flex: 1 }]} />
              <Pressable hitSlop={8} onPress={() => setTiers((ts) => ts.filter((_, j) => j !== i))}><T style={{ color: t.color.danger }}>✕</T></Pressable>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="small">Technicians only</T>
              <Switch value={x.technicianOnly} onValueChange={(v) => setTiers((ts) => ts.map((y, j) => (j === i ? { ...y, technicianOnly: v } : y)))} />
            </Row>
          </View>
        ))}
        <Button title="+ Add tier" kind="ghost" onPress={() => setTiers((ts) => [...ts, { minQty: '', price: '', technicianOnly: false }])} />
      </Card>

      <Row style={{ justifyContent: 'space-between' }}>
        <T>Visible in the marketplace</T>
        <Switch value={active} onValueChange={setActive} />
      </Row>
      <Button title={id ? 'Save changes' : 'Submit for review'} loading={save.isPending} disabled={name.trim().length < 2 || !price} onPress={() => save.mutate()} />
    </Screen>
  );
}
