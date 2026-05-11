# Улучшить поиск и объяснение законов / Criminal Law Article Search Enhancement Guide

## Обзор / Overview

Система теперь поддерживает специализированный поиск для правовых статей (например, "Уголовный закон статья 1.1", "Эрүүгийн хууль 1.1 дүгээр зүйл").

## Что было сделано / What Was Implemented

### 1. ✅ Law Explanation Service (`apps/worker/src/services/law-explanation.service.ts`)

Новый сервис для:

- Извлечение подразделов из текста статей (например, 1.1, 1.2, 2.3)
- Синтаксический анализ структуры статей
- Построение перекрестных ссылок на связанные статьи
- Генерация Markdown-объяснений

**Основные функции:**

```typescript
// Извлечение номера статьи из естественного языка
extractArticleNumberFromQuery('Criminal Law Article 1.1'); // → "1.1"
extractArticleNumberFromQuery('Эрүүгийн хууль 1.1 зүйл'); // → "1.1"

// Анализ структуры статьи
parseArticleStructure('1.1', articleText);
// → { article: "1.1", title: "...", mainContent: "...", subsections: [...], relatedArticles: [...] }

// Генерация форматированного объяснения
generateArticleExplanation(explanation);
```

### 2. ✅ Article Search Service (`apps/api/src/services/article-search.service.ts`)

Специализированный поиск для статей:

- Распознавание запросов о статьях
- Поиск по номеру статьи + подраздела
- Извлечение подразделов из результатов
- Построение структурированного объяснения

**Основные методы:**

```typescript
// Поиск конкретной статьи
await articleSearchService.searchArticle(
  'Criminal Law Article 1.1',
  'legalinfo', // для законов
);

// Поиск по номеру
await articleSearchService.searchByArticleNumber('1', '1');

// Построение объяснения
articleSearchService.buildArticleExplanation(result);
```

## Как интегрировать / Integration Steps

### Шаг 1: Инициализировать сервисы в API

В `apps/api/src/app.ts`:

```typescript
import { createArticleSearchService } from './services/article-search.service.js';

// After initializing app
const articleSearchService = createArticleSearchService(app.env);
```

### Шаг 2: Улучшить маршрут чата

В `apps/api/src/routes/v1/chat.route.ts`:

```typescript
import { getArticleSearchService } from '../../services/article-search.service.js';

// In the chat handler, before regular search:
const articleNum = extractArticleNumberFromQuery(message);

if (articleNum) {
  // Try article-specific search first
  const articleResults = await articleSearchService.searchArticle(message);

  if (articleResults.length > 0) {
    // Build article explanation response
    const articleExplanation = articleSearchService.buildArticleExplanation(articleResults[0]);

    // Use this as primary response
    const answerWithArticle = `${articleExplanation}\n\nДопълнителен контекст...\n${generationResult.answer}`;
  }
}
```

### Шаг 3: Улучшить парсер legalinfo

В `apps/worker/src/parsers/legalinfo.parser.ts`, добавить лучшее извлечение подразделов:

```typescript
// Добавить в LegalArticle interface
export interface LegalArticleWithSubs extends LegalArticle {
  subsections: Array<{ num: string; content: string }>;
}

// Обновить extractArticles()
function extractArticles(html: string): LegalArticleWithSubs[] {
  // ... существующий код ...

  // Добавить извлечение подразделов
  for (const article of articles) {
    article.subsections = extractSubsections(article.text);
  }

  return articles;
}

// Helper для подразделов
function extractSubsections(text: string): Array<{ num: string; content: string }> {
  const subsections: Array<{ num: string; content: string }> = [];
  const regex = /(\d+\.\d+)\s*(?:дахь|дэх)\s*(?:заалт|хэсэг|:)\s*([^\n]+)/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    subsections.push({
      num: match[1],
      content: match[2].trim(),
    });
  }

  return subsections;
}
```

## Тестирование / Testing

### Тест 1: Поиск по номеру статьи

```bash
curl -X POST http://localhost:3001/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Эрүүгийн хууль 1.1 дүгээр зүйл юу гэдэг вэ?",
    "conversationId": "test-001"
  }'
```

**Ожидаемый результат:**

- Возвращает полный текст статьи 1.1
- Включает подразделы (1.1.1, 1.1.2, и т.д., если они существуют)
- Высокий балл уверенности (0.9+)
- Связанные статьи перечислены

### Тест 2: Поиск подраздела

```bash
curl -X POST http://localhost:3001/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Criminal Law 1.1 subsection details",
    "conversationId": "test-002"
  }'
```

### Тест 3: Английский запрос

```bash
curl -X POST http://localhost:3001/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What is Article 1.1 of the Criminal Code about?",
    "conversationId": "test-003"
  }'
```

## Примеры использования / Usage Examples

### Пример 1: Найти и объяснить статью

```typescript
const query = 'Эрүүгийн хууль 1.1 зүйлийн зорилго юу вэ?';

// 1. Извлечь номер статьи
const articleNum = extractArticleNumberFromQuery(query);
// → "1.1"

// 2. Найти статью
const results = await articleSearchService.searchArticle(query);

// 3. Построить объяснение
if (results.length > 0) {
  const explanation = articleSearchService.buildArticleExplanation(results[0]);
  console.log(explanation);
}
```

### Пример 2: Выставить статьи с подразделами

```typescript
// Чат задает вопрос о статье
const userMessage = 'Tell me about Criminal Law article 11.3';

// Система дает ответ с подразделами:
/*
## 11.3 дүгээр зүйл
**Хүний эрүүл мэндэд хүнд хохирол учруулах**

Текст статьи...

### Дэлгэрэнгүй

- **11.3.1:** Подраздел 1 содержание...
- **11.3.2:** Подраздел 2 содержание...
- **11.3.3:** Подраздел 3 содержание...

### Холбогдох зүйлүүд

- Зүйл 10 (Хүнийг алах)
- Зүйл 12 (Бэлгийн үзүүлэлтүүд)
*/
```

## Метрики / Metrics

Система должна отчитать:

```
Article Search Metrics:
- Article Recognition Rate: 95%+ (вопросы распознаны как о статьях)
- Exact Match Rate: 90%+ (правильная статья найдена)
- Subsection Extraction: 85%+ (подразделы корректно выделены)
- Response Time: <500ms (для article-specific queries)
```

## Нужно сделать / To-Do

### Приоритет 1: Обязательно подготовить

- [ ] Интегрировать `ArticleSearchService` в `app.ts`
- [ ] Обновить `chat.route.ts` для использования article-specific search
- [ ] Обновить parser `legalinfo` для лучшего извлечения подразделов
- [ ] Создать тесты для `article-search.service.ts`

### Приоритет 2: Улучшения

- [ ] Добавить кеширование результатов statyi (Redis)
- [ ] Создать индекс статей в PostgreSQL для быстрого查询
- [ ] Implement fuzzy matching для неверно написанных номеров статей
- [ ] Добавить прямые ссылки на legalinfo.mn для каждой статьи

### Приоритет 3: Опции

- [ ] Создать запросы AI для лучшего форматирования объяснений
- [ ] Добавить примеры и правовые прецеденты (из Shuukh)
- [ ] Создать сравнение между версиями статей
- [ ] В "Параллельные законы" включить связанные статьи из других законов

## Ожидаемые улучшения / Expected Improvements

### До / Before

```
Q: "Эрүүгийн хууль 1.1"
A: Общие результаты поиска + низкая релевантность статье 1.1
```

### После / After

```
Q: "Эрүүгийн хууль 1.1 дүгээр зүйл юу вэ?"
A:
## 1.1 дүгээр зүйл
**Хуулийн зорилго**

Энэ хуулийн зорилго нь Монгол Улсын Үндсэн хуулиар баталгаажуулсан хүний эрх,
эрх чөлөө, нийтийн болон үндэсний ашиг сонирхол, Үндсэн хуулийн байгуулал,
үндэсний болон хүн төрөлхтний аюулгүй байдлыг гэмт халдлагаас хамгаалах,
гэмт хэргээс урьдчилан сэргийлэхэд оршино.

### Дэлгэрэнгүй

**1. Гол зорилго:** Эрхээ хамгаалах...
**2. Урьдчилан сэргийлэх:** Шинжүүлэлт...
**3. Нийгмийн аюулгүй байдал:** Улс төрийн...

### Холбогдох зүйлүүд

- Зүйл 1.2 (Хууль ёсны зарчим)
- Зүйл 1.3 (Шударга ёсны зарчим)
- Зүйл 1.4 (Гэм буруугийн зарчим)

[Түүлийн эхсүүлэл](https://legalinfo.mn/mn/detail/11634)

Confidence: 0.97
```

## Контактная информация / Support

Для вопросов по реализации:

1. Проверьте `apps/worker/src/services/law-explanation.service.ts`
2. Проверьте `apps/api/src/services/article-search.service.ts`
3. Запустите интеграционные тесты в `apps/api` для验证 поиска
