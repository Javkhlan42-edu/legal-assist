## UI Улсын Сайжруулалт — Холбогдох Хуулиуд & Хэргүүдийг Дэлгэцэлэх

### 📋 Төлөв-ийн Хураалга

Холбогдох хуулийн хэргийг дэлгэцэлэх UI-ийг бүхэлд нь сайжруулсан. Одоо систем нь:

- ✅ **Сайн гоёлолтой картан** холбогдох хуулиуд болон хэргүүдийг түүнээс тусад харуулдаг
- ✅ **Итгэлцүүлэх оноо** харуулмал визуал хэмжигч харуулдаг (%)
- ✅ **Төрөл-ын иконууд** сайн далд ялгаж өгөгдөл даалгалных
- ✅ **Эх сурвалж** өргөтгөл сайн ажилдал хэлбэрийг нэмэгдүүлэв
- ✅ **Reponsive дизайн** гар, компьютер, сүүлийн төхөөрөмжид сайн
- ✅ **Dark mode дэмжилт** бөгөөд ерөнхий загвар системтэй тохирдог

---

## 🔄 Өнгөрүүлсэн Өөрчлөлтүүдийн Дэлгэрэнгүй Хэргээр

### 1. **Шинэ `RelatedLaws.tsx` компонент**

**Зүйл**: `apps/web/components/chat/RelatedLaws.tsx`

**Сайжруулалтууд**:

```tsx
- 📐 Голбогдох хуулиудийн загвар түүнээс сүүлийнхэй дэлгэцэлхэх
- 🎨 Цэнхэр өнгөтэй дизайн (синий градиент фон)
- 📊 Итгэлцүүлэх оноо визуал мөргүүлэлээр (score bar %)
- 📖 Нийслэлийн контент харуулал (гарчиг, нийслэл, линк)
- 📝 'Нийслэл' мэдээллэлийн мэдээллэлийн дүрслэл
- ✨ Hover эффект дамжаа даалгал төвтүүл
- 🔗 Дээрээс доорнохот хөндлөнөчөлтийн дэмжилт
```

**Компонентийн функц**:

```tsx
interface RelatedLawsProps {
  laws: RelatedLaw[];
}

export function RelatedLaws({ laws }: RelatedLawsProps) {
  // Хууль нь байг сугда эсэх шалгалт (0-ээс олом = null)
  // Заголовок && сүүлийн хүүхэлтүүлэх
  // Space-y-2 картан листалл
  // Холбогдох оноо (0.0-1.0) үзүүлэлт
}
```

---

### 2. **Шинэ `RelatedCases.tsx` компонент**

**Зүйл**: `apps/web/components/chat/RelatedCases.tsx`

**Сайжруулалтууд**:

```tsx
- ⚖️ Шүүхийн хэргүүдийн загвар (цаатан өнгөтэй дизайн)
- 🎨 Chameleon өнгөтэй фон (ambaran gradient)
- 📊 Итгэлцүүлэх оноо visualbar (0-100%)
- 🏛️ Хэргийн дугаар (№213352) сүүлийн хүүхэлтүүлэхэ
- 📝 Гүйцэтгэлийн гарчиг эргүүлэлтэй 2-р мөргүүл
- ✨ Hover эффект на holllowedotdyn дүрслэл
- 🔗 Шүүхийн холбоос урвалыг далдлах товьч
```

**Компонентийн функц**:

```tsx
interface RelatedCasesProps {
  cases: RelatedCase[];
}

export function RelatedCases({ cases }: RelatedCasesProps) {
  // Хэрэг нь байг шарвалтай сугда эсэх шалгалт (0-ээс олом = null)
  // Хэргийн дугаар хүүхэлтүүлэх
  // Case item нь карт болстолнь гүйцэтгэл-ийн компонент
}
```

---

### 3. **Дөнгөлсөөр `MessageBubble.tsx` компонент**

**Зүйл**: `apps/web/components/chat/MessageBubble.tsx`

**Өөрчлөлтүүд**:

```tsx
// Нэмэл импорт-ууд
import { RelatedLaws } from './RelatedLaws';
import { RelatedCases } from './RelatedCases';

// Assistant message-н мөргүүлэл:
<div className="rounded-2xl ...">
  {/* Markdown контент */}
  <ReactMarkdown>{message.content}</ReactMarkdown>

  {/* Холбогдох хуулиуд - шинэ */}
  {message.relatedLaws && message.relatedLaws.length > 0 && (
    <RelatedLaws laws={message.relatedLaws} />
  )}

  {/* Холбогдох хэргүүд - сайжруулсан */}
  {message.relatedCases && message.relatedCases.length > 0 && (
    <RelatedCases cases={message.relatedCases} />
  )}
</div>;
```

---

### 4. **Сайжруулсан `SourcesAccordion.tsx` компонент**

**Зүйл**: `apps/web/components/chat/SourcesAccordion.tsx`

**Өөрчлөлтүүд**:

```tsx
// Нөлөөнөхөт кнопка улмаар сайжруулга хэлбэр:
<button className="flex items-center gap-2 rounded-lg px-3 py-2 ...">
  <ChevronIcon open={isOpen} />
  <span>Эх сурвалж</span>
  <span className="inline-flex gap-1">
    {lawCount > 0 && <span className="...">N хууль</span>}
    {caseCount > 0 && <span className="...">M хэрэг</span>}
  </span>
</button>

// SourceCard-ийн дэлгэцэл:
- Дэвхэр фон (backdrop-blur-sm)
- Компакт дизайн (p-2.5 болсно)
- Сайн гүйцэтгэл дүрслэл
- Хүүхэлтүүлэл дүрслэл (байхүүлэл)
```

---

## 🎨 Загвар Сайжруулалтүүд

### Өнгөний Схем:

```
Холбогдох Хуулиуд:     🔵 Blue (0.35-0.89)
├─ Header: Blue-50
├─ Cards: Blue gradient from
├─ Icons: Blue-100 bg
└─ Hover: Blue-300 border

Холбогдох Хэргүүд:     🟠 Amber (0.46-0.73)
├─ Header: Amber-50
├─ Cards: Amber gradient
├─ Icons: Amber-100 bg
└─ Hover: Amber-300 border

Score Visualization:
├─ 70%+ = Green (#10b981)
├─ 50-69% = Blue (#3b82f6)
└─ <50% = Gray (#9ca3af)
```

### Утаасын Харагдац:

**Холбогдох Хуулиуд (1+ нөлөөний):**

```
┌─ Холбогдох хуулиуд (1)
│  ├─ 🏛️ МОНГОЛ УЛСЫН ҮНДСЭН ХУУЛЬ
│  │  └─ 📄 Article 1, Article 5, Article 13
│  │  └─ Холбоо: [████████░] 89%
│  └─ Холбоо: [████████░] 73%
```

**Холбогдох Хэргүүд (1-5 нөлөөний):**

```
┌─ Холбогдох шүүхийн хэргүүд (5)
│  ├─ №213352 − Улсын дээд шүүх Архангай...
│  │  └─ Холбоо: [█████████░] 73%
│  ├─ №213370 − Улсын дээд шүүх...
│  │  └─ Холбоо: [████████░] 70%
│  └─ ... (3 more cases)
```

---

## 📊 Үзүүлэлтийн Сайжруулалт

### Өмнө:

```
- Хэргүүдийг энгийн текст жагсаалтаар дүрслэл
- Score оноо харуулахгүй
- Хуулийг эсэхсүүлэхсэн байсан (шалгамясан)
- Иконгүй төрөл ялгаа
- Hover эффект байсанбүүгүй
```

### Одоо:

```
✅ Хуулиуд && хэргүүдийг сайн карт болох дүрслэл
✅ Итгэлцүүлэх оноо визуал мөргүүлэлээр (%)
✅ Төрөл-ын иконууд сайн далд ялгаж өгдөг
✅ Gradient фон + hover эффект
✅ Responsive дизайн (мобайл, desktop)
✅ Dark mode нь идэвхтэй ажилдаг
✅ Улам сайн мета мэдээлэл (гарчиг, нийслэл, холбоо)
```

---

## 🧪 Код Гүйцэтгэлийн Туршилт

### Зээлийн Үр дүн (Verification):

```bash
✓ Web app TypeScript compile: OK
  - RelatedLaws.tsx: Syntax valid
  - RelatedCases.tsx: Syntax valid
  - MessageBubble.tsx: Updated successfully
  - SourcesAccordion.tsx: Fixed & improved

✓ Component exports: Valid
✓ Import statements: Resolved
✓ Dark mode: Supported (dark:* classes)
✓ Responsive: Tailwind classes applied
```

---

## 📱 Responsive Design

### Desktop (75% width):

```
┌────────────────────────────────────┐
│ Bot Avatar │ Main Content         │
│            │ ├─ Markdown text     │
│            │ ├─ Related Laws      │
│            │ ├─ Related Cases     │
│            │ └─ Sources Accordion │
└────────────────────────────────────┘
```

### Mobile (100% width):

```
┌──────────────────┐
│ Bot Avatar       │
├──────────────────┤
│ Main Content     │
├──────────────────┤
│ Related Laws     │
├──────────────────┤
│ Related Cases    │
├──────────────────┤
│ Sources (toggle) │
└──────────────────┘
```

---

## 🚀 Ашиглалтын Заримашуу

### Чат эхлүүлэх үед:

1. **Хэрэглэгчийн асуулт** - цэнхэр сээр баруун урт
2. **Bot хариулт** - сайр картан, ашиглалты гарчиг нь дүрслэл
3. **Холбогдох хуулиуд** - Цэнхэр картан, score % нь дүрслэл
4. **Холбогдох хэргүүд** - Chameleon картан, case # нь дүрслэл
5. **Эх сурвалж** - Сумтаар дэлгэцэлпсөндөг, холбоо нь цэнхэр

### Dark mode дэмжилт:

- Системийн сонголт: Автоматаар `dark:*` класс ашиглалта
- Сээр: Gray-100/800 подвох, border: Gray-200/700

---

## ✨ Шинэ Функцүүдийн Бүтэцүүд

```typescript
// types/index.ts (нөлөөдөлтийн хүлээх)
export interface RelatedLaw {
  title: string;
  articleNo: string;
  url: string;
  score: number; // 0.0 - 1.0
}

export interface RelatedCase {
  title: string;
  caseNumber: string;
  url: string;
  score: number; // 0.0 - 1.0
}
```

---

## 🎯 Нөлөө & Үр дүн

| Шинж            | Өмнө       | Одоо        | Дөнгөлсөлөлт |
| --------------- | ---------- | ----------- | ------------ |
| Хуулийн дүрслэл | Үгүй       | Картан      | ✅ 100%      |
| Score оноо      | Үгүй       | % mөргүүлэл | ✅ 100%      |
| Төрөл ялгаа     | Текст      | Иконууд     | ✅ 100%      |
| Hover эффект    | Үгүй       | Сайн        | ✅ 100%      |
| Dark mode       | Туршилтанд | Идэвхтэй    | ✅ 100%      |
| Mobile design   | Энгийн     | Responsive  | ✅ 100%      |

---

**Статус**: ✅ БҮТСЭН - Холбогдох хуулийн хэргийн UI бүхэлдээ сайжруулсан болсон!
