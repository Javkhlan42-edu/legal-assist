// ────────────────────────────────────────────────────────────
// Generation Service — Build prompt and call LLM
// ────────────────────────────────────────────────────────────

import type { ChatMessage, RelatedCase } from '@legal-chatbot/shared';
import { extractArticle, GENERATION_CONFIG, RETRIEVAL_CONFIG } from '@legal-chatbot/shared';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AppEnv } from '../config/env.js';
import { getOpenAIClient, chatCompletion } from '../lib/llm-client.js';
import type { ChromaQueryResult } from '../lib/vector-db.js';
import {
  classifyLegalIntent,
  detectQueryMode,
  getIntentLawHint,
  getIntentPreferredLawIds,
  isBankLoanQuery,
  isContractDebtBankLoanQuery,
  isPublicNoiseComplaintQuery,
  isTrafficInsuranceClaimQuery,
  type QueryMode,
  type QueryIntent,
} from './query-rewrite.service.js';
import { rerankerService } from './reranker.service.js';

export const NO_INFO_RESPONSE = 'Мэдээлэл олдсонгүй.';
const MIN_ARTICLE_SIGNAL_RATIO = 0.67;
const BROAD_INTENT_OVERVIEW_PATTERN =
  /(эрх|үүрэг|дэлгэрэнгүй|мэдээлэл|тайлбар|ерөнхий|танилцуул|юу\s+зохицуулдаг|ямар\s+эрх|ямар\s+үүрэг)/i;

const BASE_SYSTEM_PROMPT = `Та Монгол Улсын хуулийн AI зөвлөх. Хариулт нь туршлагатай хуульч хэрэглэгчид тайлбарлаж байгаа мэт энгийн, цэгцтэй, хэрэгжүүлэх алхамтай, давхардалгүй байна.

ГОЛ ДҮРЭМ:
1. Зөвхөн өгөгдсөн контекст болон эх сурвалжид байгаа хууль, зүйл, заалтад тулгуурла. Заалтын дугаар, агуулгыг бүү зохио.
2. Контекстэд байхгүй зүйл, заалт, торгуулийн хэмжээ, хугацаа, байгууллагын эрхийг таамаглахгүй. Хэрэв тодорхой биш бол "бичгээр тодруулж, баримтаа бүрдүүлэх шаардлагатай" гэж хэлнэ.
3. Хэрэглэгчийн асуултад ХАМААРАЛГҮЙ хууль, зүйлийг бүрэн хас. Жишээ нь зам тээврийн ослын асуултад "мөнгө угаах", "хүн худалдаалах", "терроризм" гэх мэт огт хамаагүй заалтыг бүү дурд. Контекстэд олон салбарын заалт холилдсон бол асуултын бодит нөхцөлд хамгийн ойрхон 2-5 заалтыг л ашигла.
4. КОНТЕКСТЭД ӨГӨГДСӨН ТҮҮХИЙ ТЕКСТИЙГ ХЭРЭГЛЭГЧИД БҮҮ ХУУЛЖ БУУЛГА. Тухайлбал "Хууль: <ТОМ ҮСЭГТ НЭР> Зүйл: <тоо> <ТОМ ҮСЭГТ ГАРЧИГ>" гэсэн OCR/preprocessed мөрийг хариулт руу хэзээ ч хуулж бичихгүй. "LLM үйлчилгээ түр боломжгүй", "Доорх контекстээс олдсон", "Контекстэд давтагдсан", "retrieval", "score", "систем", "chunk" гэх дотоод үгийг хэрэглэгчид бүү хэл.
5. Хуулийн нэрийг хүн уншихад тохиромжтой хэлбэрээр (жишээ: "Хөдөлмөрийн тухай хууль /Шинэчилсэн найруулга/") бичнэ. ТОМ ҮСГЭЭР шуудхан хуулж бичихгүй.
6. Өгүүлбэр бүрийг бүтэн дуусга. Хэт урт жагсаалт, давхардсан гарчиг, хоосон ерөнхий зөвлөгөө бүү бич.
7. Хариулт нь монгол хуульч уншигчдад тааруулсан, бодит хэрэгжүүлэх алхамтай, давхардалгүй, түүхий мэдээлэл цацраагүй байна.

ХАРИУЛТЫН БҮТЭЦ (QA):
1. "Зөвлөгөө" хэсэгт нөхцөл байдалд тохирсон дор хаяж 2 бүтэн өгүүлбэрийн шууд зөвлөгөө өг.
2. "Яг одоо хийх алхам" хэсэгт 1-ээс эхэлсэн дор хаяж 5 хэрэгжүүлэх numbered action step бич.
3. "Хуулийн тайлбар" хэсэгт зөвхөн хамааралтай хууль, зүйл, заалтыг хүний хэлээр тайлбарла. Энэ хэсэг дор хаяж 5 өгүүлбэртэй, заалт бүр хэрэглэгчийн нөхцөлд яаж үйлчлэхийг тайлбарласан байна. Эх сурвалжийн түүхий мөрийг бүү хуул.
4. "Анхаарах эрсдэл" хэсэгт хугацаа, баримт, нотолгоо, нэмэлт хариуцлагын эрсдэлийг дор хаяж 2 өгүүлбэрээр тайлбарла.
5. "Практик зөвлөгөө" хэсэгт дор хаяж 4 богино bullet зөвлөгөө өг.

ИШЛЭЛ:
- Контекстэд хуулийн нэр, articleNo, lawId, URL байгаа бол түүнийг ашигла.
- Markdown линк ашиглаж болно, гэхдээ зөвхөн legalinfo.mn эх сурвалж руу.
- Хуулийн товчлол тодорхойгүй бол бүтэн нэрээр нь бич.

ТӨГСГӨЛД ЗААВАЛ:
CONFIDENCE: X.XX
SUGGESTED_QUESTIONS:
- [холбогдох дараагийн асуулт 1]
- [холбогдох дараагийн асуулт 2]
- [холбогдох дараагийн асуулт 3]`;

const COURT_PRACTICE_SYSTEM_APPENDIX = `ШҮҮХИЙН ПРАКТИК АШИГЛАХ ЗААВАР:
- legalinfo.mn эх сурвалжийг хууль зүйн үндсэн суурь болго.
- shuukh.mn кейсийг зөвхөн төстэй нөхцөл, шүүхийн практик, эрсдэлийн чиг баримжаа гэж ашигла.
- Шүүхийн кейсийг хууль, зүйл, заалтын оронд орлуулахгүй.
- Төстэй кейс орсон бол "Шүүхийн практик" гэсэн богино хэсэгт кейсийн дугаар, гол төстэй нөхцөл, анхаарах эрсдэлийг л дурд.`;

const QUALITY_FIRST_SYSTEM_APPENDIX = `ЧАНАР НЭГДҮГЭЭРТ:
- Хурд биш, зөв ойлголт ба зөв тайлбар хамгийн чухал.
- Одоогийн хэрэглэгчийн асуулт бол заавал хариулах үндсэн даалгавар. Өмнөх яриаг зөвхөн яг холбоотой follow-up үед л туслах контекст болгон ашигла.
- Хэрэв одоогийн асуулт өмнөхөөс өөр салбар руу шилжсэн бол өмнөх хариултыг дуурайхгүй, одоогийн асуултад шинээр хариул.
- Retrieval/context-ийн түүхий текстийг хэрэглэгчид бүү буулга. "Хууль: ... Зүйл: ..." гэх OCR/raw мөрүүдийг шууд хуулж болохгүй.
- Хамааралгүй заалт гарч ирвэл бүрэн хас. Хуулийн нэр, зүйл дугаар дангаар нь хангалтгүй; заавал хэрэглэгчийн нөхцөлд яаж үйлчлэхийг энгийн монголоор тайлбарла.
- "Хуулийн тайлбар" хэсэг нь лавлах жагсаалт биш. Хуулийн ишлэл бүрийг тухайн асуултын бодит нөхцөлтэй холбож, яагаад чухал болохыг өөрийн үгээр тайлбарласан нэгдмэл хуульчийн тайлбар байна.
- Хэрэв хэрэглэгч "ямар баримт", "дараа нь яах вэ", "хугацаа нь хэд вэ" гэх follow-up асуулт асуувал өмнөх хууль зүйн асуудлыг үргэлжлүүлж, тэр нарийн асуултад шууд төвлөр. Эхний хариултыг бүтнээр нь дахин бүү давт.
- Хариулт бүр хуульч хүн тайлбарлаж байгаа мэт ойлгомжтой, хэрэгжүүлэх алхамтай, давхардалгүй байна.
- LLM эсвэл эх сурвалж сул байвал raw dump өгөхийн оронд баттай мэдэж буй практик алхам, тодруулах шаардлагатай зүйл, эрсдэлийг тайван тайлбарла.

ХУУЛИЙН ТАЙЛБАР ХЭСГИЙН ХАТУУ ДҮРЭМ:
- Final answer-д "Хуулийн үндэслэл" гарчиг бүү ашигла. Зөвхөн "Хуулийн тайлбар" гэсэн гарчиг ашигла.
- "Хуулийн тайлбар" хэсэг нийтдээ дор хаяж 5 өгүүлбэртэй байна.
- Хуулийн нэр, зүйл, заалтыг ЗААВАЛ markdown citation chip хэлбэрээр бич: [Хуулийн товчлол-ийн §зүйл](url). Жишээ: [ХТ-ийн §128](https://legalinfo.mn/mn/detail?lawId=...). URL заавал контекстээс ирсэн legalinfo.mn хаяг байна.
- ТОМ ҮСЭГТ хуулийн гарчиг, зүйлийн нэр (жишээ нь "АЖИЛТНЫ ЦАЛИН ХӨЛСИЙГ ОЛГОХ ЖУРАМ") хариулт руу шууд хуулж бичихгүй. Том үсэгтэй гарчгийг ердийн бичигдэх хэлбэрт оруулна.
- Заалт бүрийг тус тусад нь 1 богино өгүүлбэрээр тайлбарлаж, хэрэглэгчийн бодит нөхцөлд яаж үйлчлэхийг л хэлнэ. Контекстээс copy-paste хийхгүй.
- Хэрэв холбогдох заалт олдоогүй бол хуурамчаар нэр томьёо зохиохгүй, харин "Энэ нөхцөлд хамгийн ойр заалт тодрохгүй байгаа тул баримтаа бүрдүүлж бичгээр тодруулах хэрэгтэй" гэж энгийнээр хэл.`;

const STRICT_QA_GENERATION_CONTRACT = `QA ХАРИУЛТЫН ЗААВАЛ БИЕЛЭХ ШИНЭ СТАНДАРТ:
- Хариулт богино template байж болохгүй. Хуульч хүн хэрэглэгчид бодит нөхцөлийг нь ойлгож тайлбарлаж байгаа мэт дэлгэрэнгүй, ойлгомжтой бич.
- "Зөвлөгөө" хэсэг дор хаяж 2 бүтэн өгүүлбэртэй байна.
- "Яг одоо хийх алхам" хэсэг заавал 1-ээс эхэлсэн дугаарласан дор хаяж 5 бодит action step-тэй байна.
- "Хуулийн тайлбар" хэсэг дор хаяж 5 бүтэн өгүүлбэртэй байна. Энэ хэсэгт хууль, зүйл заалтыг хуурай жагсаахгүй; заалт бүр хэрэглэгчийн нөхцөлд яагаад хамаарах, ямар эрх/үүрэг/эрсдэл үүсгэхийг хүний хэлээр тайлбарлана.
- "Анхаарах эрсдэл" хэсэг дор хаяж 2 бүтэн өгүүлбэртэй байна.
- "Практик зөвлөгөө" хэсэг дор хаяж 4 bullet зөвлөгөөтэй байна.
- "Хуулийн үндэслэл", "Хуулийн заалт: 11, 83, 4..." гэх хуурай жагсаалт бүү гарга. Үүний оронд зөвхөн "Хуулийн тайлбар" гэсэн хүний ойлгох тайлбар бич.
- "Хууль: ... Зүйл: ..." гэсэн raw retrieval/OCR текст, section-only diagram, системийн дотоод үг, context/retrieval/chunk/score гэх үгийг final answer-д бүү гарга.
- Хэрэв эхний draft энэ стандартыг хангахгүй бол өөрөө дахин бичиж, дээрх бүх minimum-ийг биелүүлсэн бүтэн хариулт болго.`;

const FOLLOW_UP_FREEFORM_SYSTEM_PROMPT = `Та Монгол Улсын хуулийн AI туслах. Энэ удаагийн асуулт нь өмнөх legal сэдвийн үргэлжлэл тул хэрэглэгчийн яг асуусан нарийн зүйлд шууд, ойлгомжтой хариул.

FOLLOW-UP ДҮРЭМ:
1. Өмнөх retrieval/context болон ярианы түүхийг ашигла. Шинэ хууль тааж зохиохгүй.
2. Өмнөх үндсэн хариултыг бүтнээр нь давтахгүй.
3. Хатуу QA template шахахгүй. "Зөвлөгөө", "Яг одоо хийх алхам", "Хуулийн тайлбар" гэх бүх section заавал хэрэглэх шаардлагагүй.
4. Хэрэглэгч "ямар баримт", "дараа нь яах", "хаана хандах", "хугацаа хэд вэ" гэж асуувал тэр асуултад л төвлөр.
5. Raw retrieval text, OCR мөр, "Хууль: ... Зүйл: ...", "Контекстэд...", "retrieval", "chunk", "score" зэрэг дотоод үгсийг final answer-д гаргахгүй.
6. Хуулийг дурдвал хуурай дугаар жагсаахгүй, тухайн хэрэглэгчийн нөхцөлд яагаад хэрэгтэйг энгийн монголоор тайлбарла.
7. Хариулт natural, practical, давхардалгүй байна. Богино байж болно, гэхдээ хэрэгтэй зүйлээ тодорхой хэл.

ТӨГСГӨЛД ЗААВАЛ:
CONFIDENCE: X.XX
SUGGESTED_QUESTIONS:
- [холбогдох дараагийн асуулт 1]
- [холбогдох дараагийн асуулт 2]
- [холбогдох дараагийн асуулт 3]`;

const LEGAL_INFORMATION_DISCLAIMER =
  'Энэхүү хариулт нь ерөнхий мэдээлэл бөгөөд хуульчийн албан ёсны зөвлөгөөг орлохгүй. Таны нөхцөлд тохирсон шийдвэр гаргахын өмнө мэргэжлийн хуульчаас зөвлөгөө аваарай.';

function buildSystemPrompt(mode: QueryMode): string {
  if (mode === 'article') {
    return `${BASE_SYSTEM_PROMPT}

MODE: ARTICLE
Хуулийн нэр:
Зүйл, заалт:
Тайлбар:
Холбоос:

Зөвхөн контекстэд баталгаатай байгаа зүйл, заалтыг бич. Байхгүй бол тийм зүйл олдсонгүй гэж бич.

SUGGESTED_QUESTIONS:
- [Энэ заалттай холбоотой нарийвчилсан асуулт 1]
- [Энэ заалттай холбоотой нарийвчилсан асуулт 2]
- [Энэ заалттай холбоотой нарийвчилсан асуулт 3]`;
  }

  if (mode === 'document') {
    return `${BASE_SYSTEM_PROMPT}

MODE: DOCUMENT
Хуулийн нэр:
Юу зохицуулдаг:
Гол бүлгүүд / заалтууд:
Эхний зүйл:
Холбоос:

SUGGESTED_QUESTIONS:
- [Энэ хуулийн талаар нарийвчилсан асуулт 1]
- [Энэ хуулийн талаар нарийвчилсан асуулт 2]
- [Энэ хуулийн талаар нарийвчилсан асуулт 3]`;
  }

  return `${BASE_SYSTEM_PROMPT}

MODE: QA
Хэрэглэгч бодит асуудал асууж байгаа тул эхлээд шийдэх замыг тайлбарла, дараа нь хуулийн тайлбараа хүний хэлээр өг.

ЗАГВАР:
**Зөвлөгөө**
[дор хаяж 2 өгүүлбэрийн шууд зөвлөгөө]

**Яг одоо хийх алхам**
1. ...
2. ...
3. ...
4. ...
5. ...

**Хуулийн тайлбар**
[дор хаяж 5 өгүүлбэрээр: холбогдох заалтуудыг raw text биш, хэрэглэгчийн нөхцөлтэй холбож тайлбарла]

**Анхаарах эрсдэл**
[нотолгоо, хугацаа, буруу алхам хийвэл үүсэх үр дагаврыг дор хаяж 2 өгүүлбэрээр тайлбарла]

**Практик зөвлөгөө**
- ...
- ...
- ...
- ...

CONFIDENCE: X.XX
SUGGESTED_QUESTIONS:
- ...
- ...
- ...`;
}

// Keep default exported constant for compatibility in tests/imports.
const SYSTEM_PROMPT = buildSystemPrompt('qa');

export interface GenerationResult {
  answer: string;
  confidence: number;
  promptTokens: number;
  completionTokens: number;
  mode: 'context' | 'fallback-general' | 'no-info';
  suggestedQuestions: string[];
}

export type GenerationDetailSubIntent =
  | 'documents'
  | 'timeline'
  | 'where_to_go'
  | 'next_step'
  | 'general';

interface GenerationOptions {
  alreadyReranked?: boolean;
  answerStyle?: 'qa_contract' | 'follow_up_freeform';
  /**
   * When set to a value other than 'general', a sub-intent directive is
   * appended to the system prompt to focus the LLM on the specific aspect of
   * a prior topic the user is asking about (e.g. "ямар баримт бүрдүүлэх вэ?")
   * instead of regenerating the original full answer template.
   */
  detailSubIntent?: GenerationDetailSubIntent;
}

const SUB_INTENT_DIRECTIVES: Record<Exclude<GenerationDetailSubIntent, 'general'>, string> = {
  documents:
    'ХЭРЭГЛЭГЧИЙН АСУУЛТЫН ФОКУС: Өмнөх асуудлын хүрээнд хэрэглэгчид бүрдүүлэх баримт бичиг, нотлох баримтын жагсаалт хэрэгтэй байна. ӨМНӨХ ХАРИУЛТЫГ БҮТЭН ДАВТАХГҮЙ, гэхдээ QA contract-ийн бүтцийг заавал хадгал: Зөвлөгөө, Яг одоо хийх алхам, Хуулийн тайлбар, Анхаарах эрсдэл, Практик зөвлөгөө. "Яг одоо хийх алхам" хэсэгт дор хаяж 5 numbered алхам бичиж, алхам бүрт ямар баримт авах, хаанаас авах, эх хувь/хуулбар эсэх, хэний гарын үсэг/тамга хэрэгтэйг тодорхой тайлбарла. "Хуулийн тайлбар" хэсэг нь баримт бүр яагаад хууль зүйн ач холбогдолтойг хүний хэлээр тайлбарласан байна.',
  timeline:
    'ХЭРЭГЛЭГЧИЙН АСУУЛТЫН ФОКУС: Өмнөх асуудлын хугацаа, эцсийн огноо, мэдэгдэл/гомдол гаргах хугацаа, хугацаа хэтэрсэн үед үүсэх үр дагавар. ӨМНӨХ ХАРИУЛТЫГ БҮТЭН ДАВТАХГҮЙ. Хугацааны хэсгийг хууль зүйлтэй нь холбож бодитоор бич; хэрэв контекстэд яг хугацаа байхгүй бол "хуульд тусгайлан тодорхойлсон хугацаа олдохгүй байгаа тул эрх бүхий байгууллагын журамт хугацааг тусгайлан шалгах хэрэгтэй" гэж тайван хэл.',
  where_to_go:
    'ХЭРЭГЛЭГЧИЙН АСУУЛТЫН ФОКУС: Өмнөх асуудалд аль байгууллага/шүүх/хэнд хандах, эхлээд яаж хандах, ямар өргөдөл/хүсэлт өгөх. ӨМНӨХ ХАРИУЛТЫГ БҮТЭН ДАВТАХГҮЙ. Байгууллага тус бүрийг өргөдөл/гомдол хүлээн авах хэлбэрийг тодорхой бич, өргөдөл өгөх арга (бичгээр/цахим бүртгэл/биечлэн), дараагийн шат руу (шүүх/эрх бүхий байгууллага) яаж шилжих вэ гэдгийг харуул.',
  next_step:
    'ХЭРЭГЛЭГЧИЙН АСУУЛТЫН ФОКУС: Өмнөх хариултаас хойш ирэх яг дараагийн алхмууд. ӨМНӨХ ХАРИУЛТЫГ БҮТЭН ДАВТАХГҮЙ. "Яг одоо хийх алхам" хэсэгт дор хаяж 5 numbered алхам бичиж, алхам бүрийг хэзээ хийх, ямар баримттай хийх, үр дүнг хэрхэн баримтжуулахыг хамт тайлбарла.',
};

/**
 * Generate a grounded answer using retrieved context chunks.
 * Only uses legalinfo sources, filters out any other sources.
 */
export async function generate(
  env: AppEnv,
  query: string,
  contextChunks: ChromaQueryResult[],
  history: ChatMessage[],
  relatedCases: RelatedCase[] = [],
  options: GenerationOptions = {},
): Promise<GenerationResult> {
  const primaryQuery = extractPrimaryQuery(query);
  const mode = detectQueryMode(primaryQuery);
  const answerStyle = options.answerStyle ?? 'qa_contract';
  const useFollowUpFreeform = mode === 'qa' && answerStyle === 'follow_up_freeform';
  const resolvedIntent = resolveIntent(primaryQuery, history);

  if (resolvedIntent === 'unknown' && isGenericUnscopedLegalQuestion(primaryQuery)) {
    return {
      answer: NO_INFO_RESPONSE,
      confidence: 0,
      promptTokens: 0,
      completionTokens: 0,
      mode: 'no-info',
      suggestedQuestions: [],
    };
  }

  // Filter to ONLY legalinfo chunks (safety check - retrieval service should already filter)
  const legalinfoChunks = contextChunks.filter((c) => c.metadata.source === 'legalinfo');
  const publicNoiseScenario = isPublicNoiseComplaintQuery(primaryQuery);
  const cyberFraudScenario = isCyberFraudQuery(primaryQuery);
  const phoneTheftScenario = isPhoneTheftQuery(primaryQuery);
  const consumerRefundScenario = isConsumerRefundQuery(primaryQuery);
  const laborDismissalOrWageScenario = isLaborDismissalOrWageQuery(primaryQuery);
  const trafficInsuranceClaimScenario = isTrafficInsuranceClaimQuery(primaryQuery);
  const bankLoanOverdueScenario =
    isBankLoanOverdueQuery(primaryQuery) || isBankLoanOverdueQuery(query);

  if (mode === 'qa' && publicNoiseScenario && contextChunks.length === 0) {
    return ensureQaGenerationResultContract(
      buildPublicNoiseFallback([]),
      'unknown',
      primaryQuery,
      [],
    );
  }

  if (mode === 'qa' && bankLoanOverdueScenario && contextChunks.length === 0) {
    return ensureQaGenerationResultContract(
      buildBankLoanOverdueFallback(primaryQuery, []),
      'contract',
      primaryQuery,
      [],
    );
  }

  if (mode === 'qa' && consumerRefundScenario && contextChunks.length === 0) {
    return ensureQaGenerationResultContract(
      buildConsumerRefundFallback(primaryQuery, []),
      'contract',
      primaryQuery,
      [],
    );
  }

  if (mode === 'qa' && laborDismissalOrWageScenario && contextChunks.length === 0) {
    return ensureQaGenerationResultContract(
      buildLaborDismissalWageFallback(primaryQuery, []),
      'labor',
      primaryQuery,
      [],
    );
  }

  if (mode === 'qa' && cyberFraudScenario && contextChunks.length === 0) {
    return ensureQaGenerationResultContract(
      buildCyberFraudFallback(primaryQuery, []),
      'crime',
      primaryQuery,
      [],
    );
  }

  if (mode === 'qa' && trafficInsuranceClaimScenario && contextChunks.length === 0) {
    return ensureQaGenerationResultContract(
      buildTrafficInsuranceClaimFallback(primaryQuery, []),
      'contract',
      primaryQuery,
      [],
    );
  }

  if (mode === 'qa' && phoneTheftScenario && contextChunks.length === 0) {
    return ensureQaGenerationResultContract(
      buildPhoneTheftFallback(primaryQuery, []),
      'crime',
      primaryQuery,
      [],
    );
  }

  // If no retrieved context, ask for missing facts instead of guessing law articles.
  if (contextChunks.length === 0) {
    return buildWeakContextClarificationResult(mode, resolvedIntent, primaryQuery);
  }

  // Use legalinfo if available, otherwise use whatever chunks we have
  const chunksToUse = legalinfoChunks.length > 0 ? legalinfoChunks : contextChunks;

  // RERANK for quality improvement: score and select best chunks
  const topN = Math.max(5, RETRIEVAL_CONFIG.TOP_N);
  const rerankedChunks = options.alreadyReranked
    ? chunksToUse.slice(0, topN)
    : await rerankerService.rerank(primaryQuery, chunksToUse, topN);

  if (rerankedChunks.length === 0) {
    return buildWeakContextClarificationResult(mode, resolvedIntent, primaryQuery);
  }

  const effectiveIntent =
    resolvedIntent !== 'unknown' ? resolvedIntent : inferIntentFromChunks(rerankedChunks);

  if (effectiveIntent === 'unknown') {
    return buildWeakContextClarificationResult(mode, effectiveIntent, primaryQuery);
  }

  const intentLawHint = getIntentLawHint(effectiveIntent);
  const preferredLawIds = getIntentPreferredLawIds(effectiveIntent);
  const broadIntentOverview = isBroadIntentOverviewQuery(primaryQuery, mode);

  const intentScopedChunks = filterChunksByIntent(effectiveIntent, rerankedChunks);
  if (intentScopedChunks.length === 0) {
    return buildWeakContextClarificationResult(mode, effectiveIntent, primaryQuery);
  }

  const chunksForAnswer = intentScopedChunks;
  const allowedArticles = collectContextArticleNumbers(primaryQuery, mode, chunksForAnswer);
  const contextStrength = assessContextStrength(primaryQuery, chunksForAnswer, effectiveIntent);
  const hasCanonicalIntentContext = hasPreferredLawContext(
    chunksForAnswer,
    preferredLawIds,
    effectiveIntent,
  );
  const trafficIncidentScenario =
    effectiveIntent === 'traffic' && isTrafficIncidentScenarioQuery(primaryQuery);

  if (contextStrength === 'none') {
    if (mode === 'qa' && bankLoanOverdueScenario) {
      return ensureQaGenerationResultContract(
        buildBankLoanOverdueFallback(primaryQuery, chunksForAnswer),
        'contract',
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }
    if (mode === 'qa' && consumerRefundScenario) {
      return ensureQaGenerationResultContract(
        buildConsumerRefundFallback(primaryQuery, chunksForAnswer),
        'contract',
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }
    if (mode === 'qa' && laborDismissalOrWageScenario) {
      return ensureQaGenerationResultContract(
        buildLaborDismissalWageFallback(primaryQuery, chunksForAnswer),
        'labor',
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }
    if (mode === 'qa' && publicNoiseScenario) {
      return ensureQaGenerationResultContract(
        buildPublicNoiseFallback(chunksForAnswer),
        effectiveIntent,
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }
    if (mode === 'qa' && cyberFraudScenario) {
      return ensureQaGenerationResultContract(
        buildCyberFraudFallback(primaryQuery, chunksForAnswer),
        'crime',
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }
    if (mode === 'qa' && trafficInsuranceClaimScenario) {
      return ensureQaGenerationResultContract(
        buildTrafficInsuranceClaimFallback(primaryQuery, chunksForAnswer),
        'contract',
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }
    if (mode === 'qa' && phoneTheftScenario) {
      return ensureQaGenerationResultContract(
        buildPhoneTheftFallback(primaryQuery, chunksForAnswer),
        'crime',
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }
    return buildWeakContextClarificationResult(mode, effectiveIntent, primaryQuery);
  }

  // Scenario-specific fallbacks are intentionally reserved for empty or unusable
  // retrieval context. Once at least moderate context is available, the LLM is
  // allowed to synthesize the answer so legal explanations stay topic-specific
  // instead of collapsing into repeated deterministic templates.

  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY?.trim());
  if (!hasOpenAIKey) {
    if (mode === 'qa' && broadIntentOverview && hasCanonicalIntentContext) {
      const guidance = buildIntentGuidanceFallback(effectiveIntent, primaryQuery);
      return ensureQaGenerationResultContract(
        {
          answer: guidance.answer,
          confidence: guidance.confidence,
          promptTokens: 0,
          completionTokens: 0,
          mode: 'fallback-general',
          suggestedQuestions: guidance.suggestedQuestions,
        },
        effectiveIntent,
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }

    if (
      mode === 'qa' &&
      effectiveIntent === 'labor' &&
      /баримт|бүрдүүл|нотлох|нотолгоо|ямар/i.test(primaryQuery)
    ) {
      return ensureQaGenerationResultContract(
        buildLaborDocumentChecklistFallback(),
        effectiveIntent,
        primaryQuery,
        chunksForAnswer,
        allowedArticles,
      );
    }

    const fallback = buildModeFallbackFromContext(
      mode,
      primaryQuery,
      chunksForAnswer,
      intentLawHint,
      allowedArticles,
    );
    return mode === 'qa' && !useFollowUpFreeform
      ? ensureQaGenerationResultContract(
          {
            answer: fallback.answer,
            confidence: fallback.confidence,
            promptTokens: 0,
            completionTokens: 0,
            mode: 'context',
            suggestedQuestions: [],
          },
          effectiveIntent,
          primaryQuery,
          chunksForAnswer,
          allowedArticles,
        )
      : {
          answer: fallback.answer,
          confidence: fallback.confidence,
          promptTokens: 0,
          completionTokens: 0,
          mode: 'context',
          suggestedQuestions: [],
        };
  }

  const openai = getOpenAIClient(env.OPENAI_API_KEY, env.OPENAI_TIMEOUT_MS);

  // Build context block from reranked chunks
  const contextReferenceGuide = buildContextReferenceGuide(primaryQuery, chunksForAnswer);
  const contextBlock = buildContextBlock(primaryQuery, chunksForAnswer, relatedCases);

  // Truncate history to max allowed messages
  const maxHistory = GENERATION_CONFIG.MAX_HISTORY_MESSAGES;
  const trimmedHistory = history.slice(-maxHistory);

  const subIntentDirective =
    options.detailSubIntent && options.detailSubIntent !== 'general'
      ? SUB_INTENT_DIRECTIVES[options.detailSubIntent]
      : '';

  const systemPrompt = useFollowUpFreeform
    ? `${FOLLOW_UP_FREEFORM_SYSTEM_PROMPT}\n\n${COURT_PRACTICE_SYSTEM_APPENDIX}${
        subIntentDirective ? `\n\nFOLLOW-UP ФОКУС:\n${subIntentDirective}` : ''
      }`
    : `${buildSystemPrompt(mode)}\n\n${QUALITY_FIRST_SYSTEM_APPENDIX}\n\n${STRICT_QA_GENERATION_CONTRACT}\n\n${COURT_PRACTICE_SYSTEM_APPENDIX}${
        subIntentDirective ? `\n\n${subIntentDirective}` : ''
      }`;

  const userPrompt = useFollowUpFreeform
    ? `ЭНЭ БОЛ ӨМНӨХ СЭДВИЙН ҮРГЭЛЖЛЭЛ АСУУЛТ.

Өмнөх яриа болон доорх эх сурвалжийг ашиглаад хэрэглэгчийн одоогийн асуултад шууд хариул.
Үндсэн QA template-ийг давтахгүй. Шинэ retrieval хийсэн мэт хууль нэмж таахгүй.

ГОЛ ЛАВЛАХ ЗААЛТУУД:
${contextReferenceGuide}

КОНТЕКСТ (өмнөх retrieval/source):

${contextBlock}

---

ХАРИУЛТЫН РЕЖИМ: FOLLOW_UP_FREEFORM
АСУУЛТЫН САЛБАР: ${intentLawHint || 'Тодорхойгүй'}
КОНТЕКСТ ЧАНАР: ${contextStrength}
ОДООГИЙН FOLLOW-UP АСУУЛТ: ${primaryQuery}`
    : `ОДООГИЙН АСУУЛТАД ХАРИУЛ. Өмнөх яриа байгаа бол зөвхөн холбоотой үед туслах контекст гэж үз.

ГОЛ ЛАВЛАХ ЗААЛТУУД:
${contextReferenceGuide}

КОНТЕКСТ (эх сурвалжууд):

${contextBlock}

---

ХАРИУЛТЫН РЕЖИМ: ${mode.toUpperCase()}
АСУУЛТЫН САЛБАР: ${intentLawHint || 'Тодорхойгүй'}
КОНТЕКСТ ЧАНАР: ${contextStrength}
ЗӨВШӨӨРӨГДСӨН ЗҮЙЛИЙН ДУГААР: ${allowedArticles.length > 0 ? allowedArticles.map((num) => `${num} зүйл`).join(', ') : 'Байхгүй'}
ОДООГИЙН АСУУЛТ: ${primaryQuery}`;

  // Build messages array
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
    // Conversation history
    ...trimmedHistory.map(
      (msg): ChatCompletionMessageParam => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }),
    ),
    // Current query with context
    {
      role: 'user',
      content: userPrompt,
    },
  ];

  // Call LLM
  let text: string;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const llmResponse = await chatCompletion(openai, messages, {
      model: env.OPENAI_CHAT_MODEL,
      temperature: GENERATION_CONFIG.TEMPERATURE,
      maxTokens: GENERATION_CONFIG.MAX_RESPONSE_TOKENS,
    });
    text = llmResponse.text;
    promptTokens = llmResponse.promptTokens;
    completionTokens = llmResponse.completionTokens;
  } catch (error) {
    console.warn(
      `[generation] LLM unavailable (${error instanceof Error ? error.message : String(error)}), using extractive fallback`,
    );
    const fallback = buildModeFallbackFromContext(
      mode,
      primaryQuery,
      chunksForAnswer,
      intentLawHint,
      allowedArticles,
    );
    return mode === 'qa'
      ? ensureQaGenerationResultContract(
          {
            answer: fallback.answer,
            confidence: fallback.confidence,
            promptTokens: 0,
            completionTokens: 0,
            mode: 'context',
            suggestedQuestions: [],
          },
          effectiveIntent,
          primaryQuery,
          chunksForAnswer,
          allowedArticles,
        )
      : {
          answer: fallback.answer,
          confidence: fallback.confidence,
          promptTokens: 0,
          completionTokens: 0,
          mode: 'context',
          suggestedQuestions: [],
        };
  }

  // Parse suggested questions, then confidence
  const { text: textWithoutQuestions, questions: suggestedQuestions } =
    parseSuggestedQuestions(text);
  let finalSuggestedQuestions = suggestedQuestions;
  const { answer, confidence } = parseConfidence(textWithoutQuestions);
  const grounded = enforceArticleGrounding(answer, allowedArticles, mode);
  let finalAnswer = grounded.answer;
  let finalConfidence = grounded.adjusted ? Math.min(confidence, 0.74) : confidence;

  // Safety net for detail follow-ups asking "ямар баримт бүрдүүлэх вэ?". When
  // the LLM does not produce a strong document checklist (too short, too few
  // bullets, missing key terms), fall back to the deterministic checklist for
  // the active intent so the user always receives an actionable list instead of
  // a vague restatement of the prior answer.
  if (
    mode === 'qa' &&
    !useFollowUpFreeform &&
    options.detailSubIntent === 'documents' &&
    finalAnswer.trim() !== NO_INFO_RESPONSE &&
    isWeakDocumentChecklistAnswer(finalAnswer)
  ) {
    const checklist = ensureQaGenerationResultContract(
      buildDocumentChecklistByIntent(effectiveIntent),
      effectiveIntent,
      primaryQuery,
      chunksForAnswer,
      allowedArticles,
    );
    finalAnswer = checklist.answer;
    finalConfidence = Math.max(finalConfidence, checklist.confidence);
  }

  const groundedText = finalAnswer.trim().toLowerCase();
  const noInfoText = NO_INFO_RESPONSE.toLowerCase();
  if (
    groundedText === noInfoText ||
    groundedText === 'мэдээлэл олдсонгүй' ||
    groundedText.startsWith(`${noInfoText}\n`) ||
    groundedText.startsWith(`${noInfoText} `)
  ) {
    if (mode === 'qa' && trafficIncidentScenario) {
      if (hasCanonicalIntentContext) {
        const fallback = buildTrafficIncidentFallback(primaryQuery, chunksForAnswer);
        const guidance = buildIntentGuidanceFallback(effectiveIntent, primaryQuery);
        return ensureQaGenerationResultContract(
          {
            answer: fallback.answer,
            confidence: fallback.confidence,
            promptTokens,
            completionTokens,
            mode: 'context',
            suggestedQuestions: guidance.suggestedQuestions,
          },
          effectiveIntent,
          primaryQuery,
          chunksForAnswer,
          allowedArticles,
        );
      }

      const fallback = buildWeakContextClarificationResult(mode, effectiveIntent, primaryQuery);
      return {
        ...fallback,
        promptTokens,
        completionTokens,
      };
    }

    if (mode === 'qa' && broadIntentOverview) {
      if (hasCanonicalIntentContext) {
        const guidance = buildIntentGuidanceFallback(effectiveIntent, primaryQuery);
        return ensureQaGenerationResultContract(
          {
            answer: guidance.answer,
            confidence: guidance.confidence,
            promptTokens,
            completionTokens,
            mode: 'fallback-general',
            suggestedQuestions: guidance.suggestedQuestions,
          },
          effectiveIntent,
          primaryQuery,
          chunksForAnswer,
          allowedArticles,
        );
      }

      const fallback = buildWeakContextClarificationResult(mode, effectiveIntent, primaryQuery);
      return {
        ...fallback,
        promptTokens,
        completionTokens,
      };
    }

    return {
      answer: NO_INFO_RESPONSE,
      confidence: 0,
      promptTokens,
      completionTokens,
      mode: 'no-info',
      suggestedQuestions: [],
    };
  }

  finalAnswer = cleanupAnswerStructure(finalAnswer);
  finalAnswer = ensureLegalLinksInAnswer(finalAnswer, primaryQuery, chunksForAnswer);

  // Self-critique safety net: if deterministic cleanup left OCR or off-topic
  // leakage in place we ask the LLM to rewrite the answer once. This is a
  // belt-and-braces fallback — most cases are already handled by stripOcrLeakage
  // and matchesIntentInCorpus.
  if (hasOcrOrInternalLeakage(finalAnswer)) {
    const rewritten = await runSelfCritique(env, primaryQuery, finalAnswer);
    if (rewritten) {
      const cleanedRewrite = ensureLegalLinksInAnswer(
        cleanupAnswerStructure(rewritten),
        primaryQuery,
        chunksForAnswer,
      );
      if (!hasOcrOrInternalLeakage(cleanedRewrite)) {
        finalAnswer = cleanedRewrite;
        finalConfidence = Math.min(finalConfidence, 0.7);
      }
    }
  }

  if (mode === 'qa' && !useFollowUpFreeform && finalAnswer.trim() !== NO_INFO_RESPONSE) {
    let qualityReport = validateQaAnswerQuality(finalAnswer);
    if (!qualityReport.ok || shouldForceDetailedQaAnswer(finalAnswer)) {
      const repaired = await repairWeakQaAnswer({
        env,
        query: primaryQuery,
        draft: finalAnswer,
        chunks: chunksForAnswer,
        intent: effectiveIntent,
        allowedArticles,
        issues: qualityReport.issues,
      });

      if (repaired) {
        promptTokens += repaired.promptTokens;
        completionTokens += repaired.completionTokens;

        const { text: repairedWithoutQuestions, questions: repairedQuestions } =
          parseSuggestedQuestions(repaired.text);
        const { answer: repairedAnswer, confidence: repairedConfidence } =
          parseConfidence(repairedWithoutQuestions);
        const repairedGrounded = enforceArticleGrounding(repairedAnswer, allowedArticles, mode);
        const cleanedRepair = ensureLegalLinksInAnswer(
          cleanupAnswerStructure(repairedGrounded.answer),
          primaryQuery,
          chunksForAnswer,
        );

        if (cleanedRepair && !hasOcrOrInternalLeakage(cleanedRepair)) {
          finalAnswer = cleanedRepair;
          finalConfidence = Math.min(
            Math.max(finalConfidence, repairedConfidence),
            repairedGrounded.adjusted ? 0.74 : 0.86,
          );
          if (repairedQuestions.length > 0) {
            finalSuggestedQuestions = repairedQuestions;
          }
        }
      }

      qualityReport = validateQaAnswerQuality(finalAnswer);
      if (!qualityReport.ok || shouldForceDetailedQaAnswer(finalAnswer)) {
        const fallback = buildDetailedQaFallbackFromContext(
          primaryQuery,
          chunksForAnswer,
          effectiveIntent,
          allowedArticles,
        );
        finalAnswer = ensureLegalLinksInAnswer(
          cleanupAnswerStructure(fallback.answer),
          primaryQuery,
          chunksForAnswer,
        );
        finalConfidence = Math.min(finalConfidence, fallback.confidence);
      }
    }
  }

  finalAnswer = appendLegalInformationDisclaimer(finalAnswer, mode);

  return {
    answer: finalAnswer,
    confidence: finalConfidence,
    promptTokens,
    completionTokens,
    mode: 'context',
    suggestedQuestions: finalSuggestedQuestions,
  };
}

const SELF_CRITIQUE_SYSTEM_PROMPT = `Та өмнөх хариултыг шалгаж, цэвэрлэдэг хуулийн редактор. Дараах алдаа байвал засаж бүтэн хариултыг буцаа:
1. "Хууль: <НЭР> Зүйл: <тоо> <ТОМ ҮСЭГТ ГАРЧИГ>" гэх OCR/түүхий текст хуулсан байвал хас.
2. Асуултад огт хамаагүй заалт (жишээ: зам тээврийн ослын асуултад "мөнгө угаах", "хүн худалдаалах", "терроризм") байвал хас.
3. "LLM үйлчилгээ түр боломжгүй", "Доорх контекстээс олдсон", "retrieval", "score", "chunk" зэрэг дотоод үг байвал хас.
4. Бүтэц нь Зөвлөгөө → Яг одоо хийх алхам → Хуулийн тайлбар → Анхаарах эрсдэл → Практик зөвлөгөө хэлбэртэй байна.
5. "Зөвлөгөө" дор хаяж 2 өгүүлбэр, "Яг одоо хийх алхам" дор хаяж 5 numbered алхам, "Хуулийн тайлбар" дор хаяж 5 өгүүлбэр, "Анхаарах эрсдэл" дор хаяж 2 өгүүлбэр, "Практик зөвлөгөө" дор хаяж 4 bullet байна.
6. "Хуулийн үндэслэл", "Хуулийн заалт: 11, 83..." гэх хуурай жагсаалт хэрэглэж болохгүй.
Эдгээр алдаа байхгүй бол хариултыг яг тэр хэвээр нь буцаа. Шинэ зүйл, заалт нэмж зохиохгүй.`;

async function runSelfCritique(env: AppEnv, query: string, draft: string): Promise<string | null> {
  if (!env.OPENAI_API_KEY?.trim()) {
    return null;
  }

  try {
    const openai = getOpenAIClient(env.OPENAI_API_KEY, env.OPENAI_TIMEOUT_MS);
    const response = await chatCompletion(
      openai,
      [
        { role: 'system', content: SELF_CRITIQUE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `АСУУЛТ: ${query}\n\nОДООГИЙН ХАРИУЛТ:\n${draft}\n\nДээрх дүрмээр шалгаж засаад бүтэн хариултыг буцаа.`,
        },
      ],
      {
        model: env.OPENAI_CHAT_MODEL,
        temperature: 0.1,
        maxTokens: GENERATION_CONFIG.MAX_RESPONSE_TOKENS,
      },
    );

    const text = response.text?.trim() ?? '';
    return text.length > 0 ? text : null;
  } catch (error) {
    console.warn(
      `[generation] self-critique failed (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

type QaRepairResult = {
  text: string;
  promptTokens: number;
  completionTokens: number;
};

async function repairWeakQaAnswer(params: {
  env: AppEnv;
  query: string;
  draft: string;
  chunks: ChromaQueryResult[];
  intent: QueryIntent;
  allowedArticles: string[];
  issues: string[];
}): Promise<QaRepairResult | null> {
  const { env, query, draft, chunks, intent, allowedArticles, issues } = params;
  if (!env.OPENAI_API_KEY?.trim()) {
    return null;
  }

  try {
    const openai = getOpenAIClient(env.OPENAI_API_KEY, env.OPENAI_TIMEOUT_MS);
    const contextReferenceGuide = buildContextReferenceGuide(query, chunks);
    const contextBlock = buildContextBlock(query, chunks, []);
    const response = await chatCompletion(
      openai,
      [
        {
          role: 'system',
          content: `Та Монгол Улсын хуулийн чанарын редактор. Доорх draft хариултыг хэрэглэгчид ойлгомжтой, хуульчийн тайлбар хэлбэртэй бүтэн QA хариулт болгон ДАХИН БИЧ.

ЗААВАЛ БҮТЭЦ:
**Зөвлөгөө**
- Дор хаяж 2 бүтэн өгүүлбэр.

**Яг одоо хийх алхам**
- Заавал 1-ээс эхэлсэн дор хаяж 5 numbered action step.

**Хуулийн тайлбар**
- Дор хаяж 5 бүтэн өгүүлбэр.
- "Хууль: ... Зүйл: ..." raw text бүү хуул.
- Хуулийн дугаар, citation chip ашиглаж болно, гэхдээ заавал тухайн хэрэглэгчийн нөхцөлд яагаад хамаарахыг хүний хэлээр тайлбарла.

**Анхаарах эрсдэл**
- Дор хаяж 2 бүтэн өгүүлбэр.

**Практик зөвлөгөө**
- Дор хаяж 4 bullet зөвлөгөө.

ХОРИГЛОХ:
- "Хуулийн үндэслэл" гарчиг.
- "Хуулийн заалт: 11, 83, 4..." гэх хуурай жагсаалт.
- "retrieval", "chunk", "score", "context", "LLM үйлчилгээ түр боломжгүй" гэх системийн үг.
- Хамааралгүй хууль, зүйл зохиох.

Эх сурвалжид байхгүй зүйл, хугацаа, торгуулийн хэмжээг бүү зохио. Хэрэв тодорхой бус бол баримтаа бичгээр тодруулах шаардлагатай гэж энгийнээр тайлбарла.

Төгсгөлд:
CONFIDENCE: X.XX
SUGGESTED_QUESTIONS:
- ...
- ...
- ...`,
        },
        {
          role: 'user',
          content: `АСУУЛТ: ${query}
АСУУЛТЫН САЛБАР: ${intent}
ЗАСАХ ШАЛТГААН: ${issues.join(', ') || 'quality_contract_failed'}
ЗӨВШӨӨРӨГДСӨН ЗҮЙЛИЙН ДУГААР: ${
            allowedArticles.length > 0
              ? allowedArticles.map((article) => `${article} зүйл`).join(', ')
              : 'Контекстээс баталгаатай зүйл тодорхойгүй'
          }

ГОЛ ЛАВЛАХ ЗААЛТУУД:
${contextReferenceGuide}

КОНТЕКСТ:
${contextBlock}

ОДООГИЙН СУЛ DRAFT:
${draft}

Дээрх draft-ийг бүрэн дахин бич. Хэрэглэгчид шууд уншигдах final answer л буцаа.`,
        },
      ],
      {
        model: env.OPENAI_CHAT_MODEL,
        temperature: 0.15,
        maxTokens: GENERATION_CONFIG.MAX_RESPONSE_TOKENS,
      },
    );

    const text = response.text?.trim() ?? '';
    if (!text) {
      return null;
    }

    return {
      text,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
    };
  } catch (error) {
    console.warn(
      `[generation] qa repair failed (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────

function shouldForceDetailedQaAnswer(answer: string): boolean {
  const cleaned = answer
    .replace(/\[[^\]]+\]\([^)]*\)/g, ' ') // strip markdown links before counting words
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = cleaned ? cleaned.split(' ').length : 0;
  const sectionCount = (answer.match(/(?:^|\n)\s*(?:\d+\.|\*\*[^*]+\*\*)/g) ?? []).length;
  const hasPracticalTips = /Практик\s+зөвлөгөө/i.test(answer);
  const hasInternalOrRawDump = hasOcrOrInternalLeakage(answer);

  const isSeverelyUnderdeveloped = wordCount < 90;
  const isEffectivelyUnstructured = sectionCount < 2 && !hasPracticalTips;

  return hasInternalOrRawDump || isSeverelyUnderdeveloped || isEffectivelyUnstructured;
}

type QaAnswerSections = {
  advice: string;
  actions: string;
  lawExplanation: string;
  risks: string;
  practicalTips: string;
};

export interface QaAnswerQualityReport {
  ok: boolean;
  issues: string[];
  metrics: {
    adviceSentences: number;
    actionSteps: number;
    lawExplanationSentences: number;
    riskSentences: number;
    practicalTips: number;
  };
}

function normalizeQaHeading(line: string): keyof QaAnswerSections | null {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*/, '')
    .replace(/\*\*$/, '')
    .replace(/[:：]\s*$/, '')
    .trim()
    .toLowerCase();

  if (!normalized) {
    return null;
  }

  if (/^зөвлөгөө$/.test(normalized)) {
    return 'advice';
  }

  if (/^(яг\s+одоо\s+хийх\s+алхам|яаралтай\s+авах\s+арга\s+хэмжээ|яг\s+одоо\s+бүрдүүлэх\s+баримт|бүрдүүлэх\s+баримт)/i.test(normalized)) {
    return 'actions';
  }

  if (/^(хуулийн\s+тайлбар|хуулийн\s+үндэслэл|холбогдох\s+хуулийн\s+үндэслэл|хуулийн\s+заалт)/i.test(normalized)) {
    return 'lawExplanation';
  }

  if (/^(анхаарах\s+эрсдэл|анхаарах\s+зүйл|эрсдэл)/i.test(normalized)) {
    return 'risks';
  }

  if (/^практик\s+зөвлөгөө/i.test(normalized)) {
    return 'practicalTips';
  }

  return null;
}

function extractQaAnswerSections(answer: string): QaAnswerSections {
  const sections: QaAnswerSections = {
    advice: '',
    actions: '',
    lawExplanation: '',
    risks: '',
    practicalTips: '',
  };
  let current: keyof QaAnswerSections = 'advice';
  let sawHeading = false;

  for (const line of answer.split('\n')) {
    const trimmed = line.trim();
    if (/^(CONFIDENCE|SUGGESTED_QUESTIONS)\s*:/i.test(trimmed)) {
      break;
    }

    const heading = normalizeQaHeading(trimmed);
    if (heading) {
      current = heading;
      sawHeading = true;
      continue;
    }

    if (!sawHeading && trimmed.length === 0) {
      continue;
    }

    sections[current] = `${sections[current]}${sections[current] ? '\n' : ''}${line}`;
  }

  return sections;
}

function stripMarkdownForCounting(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/^[\s>*-]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countSentences(text: string): number {
  const cleaned = stripMarkdownForCounting(text);
  if (!cleaned) {
    return 0;
  }

  const sentenceMatches = cleaned.match(/[^.!?。！？]+[.!?。！？]+/gu) ?? [];
  if (sentenceMatches.length > 0) {
    return sentenceMatches.length;
  }

  return cleaned.length >= 40 ? 1 : 0;
}

function extractNumberedOrBulletItems(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    const numbered = trimmed.match(/^\d+\.\s+(.+)/);
    const bullet = trimmed.match(/^[-*]\s+(.+)/);
    const value = numbered?.[1] ?? bullet?.[1];
    if (value?.trim()) {
      items.push(value.trim());
    }
  }
  return items;
}

function countNumberedActionSteps(section: string): number {
  return (section.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
}

function countPracticalTips(section: string): number {
  return (section.match(/^\s*[-*]\s+\S/gm) ?? []).length;
}

function hasDryReferenceLeakage(answer: string): boolean {
  return (
    /Хуулийн\s+заалт\s*[:：]\s*(?:\d+[\s,]*){2,}/iu.test(answer) ||
    /Хууль\s*[:：]\s*[^.\n]{3,200}?\s+Зүйл\s*[:：]/iu.test(answer) ||
    /(?:^|\n)\s*\d+\s*\n\s*(?:Зөвлөгөө|Яг одоо хийх алхам|Хуулийн тайлбар|Анхаарах эрсдэл)/iu.test(
      answer,
    )
  );
}

function isDryLawExplanation(section: string): boolean {
  const stripped = stripMarkdownForCounting(section);
  if (!stripped) {
    return true;
  }

  if (/Хуулийн\s+заалт\s*[:：]|Хууль\s*[:：]\s*.*Зүйл\s*[:：]/iu.test(section)) {
    return true;
  }

  const nonEmptyLines = section.split('\n').map((line) => line.trim()).filter(Boolean);
  const bulletCitationLines = nonEmptyLines.filter((line) => /^[-*]?\s*\[[^\]]+\]\([^)]+\)/.test(line));
  return nonEmptyLines.length > 0 && bulletCitationLines.length === nonEmptyLines.length;
}

export function validateQaAnswerQuality(answer: string): QaAnswerQualityReport {
  const sections = extractQaAnswerSections(answer);
  const metrics = {
    adviceSentences: countSentences(sections.advice),
    actionSteps: countNumberedActionSteps(sections.actions),
    lawExplanationSentences: countSentences(sections.lawExplanation),
    riskSentences: countSentences(sections.risks),
    practicalTips: countPracticalTips(sections.practicalTips),
  };
  const issues: string[] = [];

  if (!sections.advice.trim()) issues.push('missing_advice');
  if (!sections.actions.trim()) issues.push('missing_actions');
  if (!sections.lawExplanation.trim()) issues.push('missing_law_explanation');
  if (!sections.risks.trim()) issues.push('missing_risks');
  if (!sections.practicalTips.trim()) issues.push('missing_practical_tips');
  if (metrics.adviceSentences < 2) issues.push('short_advice');
  if (metrics.actionSteps < 5) issues.push('too_few_action_steps');
  if (metrics.lawExplanationSentences < 5) issues.push('short_law_explanation');
  if (metrics.riskSentences < 2) issues.push('short_risks');
  if (metrics.practicalTips < 4) issues.push('too_few_practical_tips');
  if (hasOcrOrInternalLeakage(answer) || hasDryReferenceLeakage(answer)) issues.push('raw_or_internal_leakage');
  if (isDryLawExplanation(sections.lawExplanation)) issues.push('dry_law_reference_list');
  if (/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?Хуулийн\s+(?:үндэслэл|заалт)(?:\*\*)?\s*[:：]?\s*$/imu.test(answer)) {
    issues.push('old_law_basis_heading');
  }

  return { ok: issues.length === 0, issues, metrics };
}

function appendUniqueItems(base: string[], additions: string[], minCount: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of [...base, ...additions]) {
    const normalized = normalizeForMatch(item).replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(item.trim().replace(/\s+/g, ' '));
    if (result.length >= minCount) {
      break;
    }
  }
  return result;
}

function genericActionStepAdditions(): string[] {
  return [
    'Холбогдох бүх баримтыг огнооны дарааллаар нэг хавтаст нэгтгэж, эх хувь болон хуулбарыг тусад нь хадгална.',
    'Нөгөө тал эсвэл холбогдох байгууллагад шаардлага, хүсэлтээ амаар биш бичгээр өгч, хүлээн авсан баримтыг үлдээнэ.',
    'Хариу өгөх тодорхой хугацаа зааж, хугацаа дуусахад дараагийн шатны байгууллага эсвэл шүүхэд хандах бэлтгэлээ хийнэ.',
    'Мөнгөн шаардлага байгаа бол үндсэн төлбөр, хүү, алданги, хохирол, нэмэлт зардлыг тус тусад нь тооцож бичнэ.',
    'Имэйл, чат, мессеж, зураг, видео зэрэг цахим нотолгоог устгахгүйгээр эх хэлбэрээр нь хадгалж, шаардлагатай бол хэвлэж хавсаргана.',
  ];
}

function ensureMinimumActionSteps(existingSection: string, intent: QueryIntent, query: string): string[] {
  const existingItems = extractNumberedOrBulletItems(existingSection);
  const intentItems = buildQaActionSteps(intent, query);
  return appendUniqueItems(existingItems, [...intentItems, ...genericActionStepAdditions()], 5);
}

function genericPracticalTipAdditions(): string[] {
  return [
    'Гол баримтуудаа эх хувиар нь хадгалж, шүүх эсвэл байгууллагад өгөхдөө хуулбар хавсарга.',
    'Албан харилцаанд огноо, шаардлага, хариу өгөх хугацааг тодорхой бич.',
    'Аман тохиролцоонд дангаар нь найдахгүй, бүх тохиролцоо болон татгалзлыг бичгээр баталгаажуул.',
    'Маргаан хүндрэх шинжтэй бол баримтаа бүрдүүлсний дараа мэргэшсэн хуульчаас урьдчилан зөвлөгөө ав.',
  ];
}

function ensureMinimumPracticalTips(existingSection: string, intent: QueryIntent, query: string): string[] {
  const existingItems = extractNumberedOrBulletItems(existingSection);
  const intentItems = buildQaPracticalTips(intent, query);
  return appendUniqueItems(existingItems, [...intentItems, ...genericPracticalTipAdditions()], 4);
}

function ensureAdviceText(existing: string, intent: QueryIntent, query: string): string {
  const cleaned = stripMarkdownForCounting(existing);
  const base = cleaned.length > 0 ? cleaned : buildQaOpeningAdvice(intent, query);
  if (countSentences(base) >= 2) {
    return base;
  }

  const addition =
    intent === 'labor'
      ? 'Ийм үед тушаал, гэрээ, цалингийн баримт зэрэг бичгийн нотолгоо таны шаардлагын үндсэн тулгуур болно.'
      : intent === 'traffic'
        ? 'Ийм үед ослын газар дээрх баримт, цагдаагийн бүртгэл, даатгалын мэдэгдэл гурвыг алдахгүй бүрдүүлэх нь хамгийн чухал.'
        : intent === 'contract'
          ? 'Ийм үед гэрээ, төлбөрийн баримт, бичгээр өгсөн шаардлага, хариу нь маргааны гол нотолгоо болдог.'
          : 'Иймд эхлээд баримтаа бүрдүүлж, дараа нь шаардлагаа бичгээр тодорхой гаргах нь зөв.';
  return `${base.replace(/[.!?。！？]*$/u, '.')} ${addition}`;
}

function intentLawExplanationAdditions(intent: QueryIntent, query: string): string[] {
  if (intent === 'labor') {
    return [
      'Ажил олгогч хөдөлмөрийн харилцааг дуусгавар болгохдоо хуульд заасан үндэслэл, журам, бичгийн шийдвэр, тооцоог нотлох үүрэгтэй.',
      'Ажлаас халсан тушаалын огноо, үндэслэл, ажилтанд гардуулсан байдал нь маргаан шийдвэрлэхэд шууд ач холбогдолтой.',
      'Цалин, олговор, ажилгүй байсан хугацааны нөхөн төлбөрийг шаардах эсэх нь ажилласан хугацаа, цалингийн баримт, ажил олгогчийн шийдвэр хууль ёсны байсан эсэхээс хамаарна.',
    ];
  }

  if (intent === 'traffic') {
    return [
      'Зам тээврийн ослын үед жолоочийн ослын дараах үүрэг, цагдаад мэдэгдэх ажиллагаа, хохирол тогтоох баримтжуулалт хамтад нь үнэлэгдэнэ.',
      'Хүн гэмтсэн эсэх, согтууруулах ундаа хэрэглэсэн эсэх, ослын газраас явсан эсэх, хохирлын хэмжээ зэрэг нь зөрчил эсвэл эрүүгийн хариуцлагын заагийг тодорхойлдог.',
      'Даатгалын нөхөн төлбөр авахад ослын акт, зураг, үнэлгээ, даатгалд мэдэгдсэн хугацаа зэрэг нь хууль зүйн чухал баримт болно.',
    ];
  }

  if (intent === 'contract') {
    const isLoan = isBankLoanQuery(query) || isContractDebtBankLoanQuery(query);
    return isLoan
      ? [
          'Зээлийн харилцаанд төлбөр хугацаандаа төлөгдөөгүй бол эхлээд иргэний эрх зүйн үүргийн зөрчил гэж үнэлэгддэг.',
          'Банк ямар нэмэлт төлбөр шаардах нь зээлийн гэрээ, хүү, нэмэгдүүлсэн хүү, алданги, барьцааны нөхцөл хуульд нийцсэн эсэхээс хамаарна.',
          'Барьцаатай зээлийн хувьд банк барьцаа хэрэгжүүлэхээс өмнө мэдэгдэл, тооцоо, шаардлагын дарааллыг гэрээ болон хуульд нийцүүлсэн эсэхийг шалгах хэрэгтэй.',
        ]
      : [
          'Гэрээний маргаанд талууд яг юу тохирсон, ямар хугацаа тогтоосон, ямар үүрэг зөрчигдсөн, ямар хохирол үүссэн гэдгийг баримтаар шалгана.',
          'Нэхэмжлэл гаргахдаа үндсэн шаардлага, хохирлын тооцоо, алданги эсвэл торгуулийн үндэслэлийг тус тусад нь тодорхойлох шаардлагатай.',
          'Аман тохиролцоог нотлоход хүндрэлтэй тул бичгээр өгсөн шаардлага, төлбөрийн баримт, мессеж, имэйл зэрэг нотолгоо чухал болно.',
        ];
  }

  if (intent === 'crime') {
    return [
      'Эрүүгийн шинжтэй асуудалд хамгийн түрүүнд болсон үйл явдал, хохирол, буруутай байж болзошгүй этгээд, нотлох баримтыг бүртгүүлж шалгуулна.',
      'Цагдаад өгсөн гомдол, шилжүүлгийн баримт, чат, зураг, гэрчийн мэдээлэл зэрэг нь мөрдөн шалгах ажиллагааны эхний суурь болдог.',
      'Гэмт хэрэг мөн эсэх, эсвэл иргэний маргаан уу гэдгийг мөрдөн шалгах байгууллага баримтад тулгуурлан ялгаж тогтооно.',
    ];
  }

  return [
    'Энэ төрлийн асуудалд зөв хууль хэрэглэхийн тулд бодит үйл баримт, хугацаа, бичгийн нотолгоо, хандах байгууллага зэргийг хамтад нь үнэлнэ.',
    'Хуулийн заалт дангаараа хангалтгүй тул тухайн заалт таны нөхцөлд ямар эрх, үүрэг, шаардлага, эрсдэл үүсгэхийг баримттай нь тулгах хэрэгтэй.',
    'Иймээс эхлээд нотлох баримтаа эмхэлж, дараа нь шаардлагаа бичгээр гаргах дараалал хамгийн найдвартай байдаг.',
  ];
}

function buildReferenceExplanationSentence(ref: QaReference, intent: QueryIntent): string {
  const label = ref.shortLabel ? `${ref.shortLabel}` : 'энэ асуудлын эрх, үүргийг тодруулах зохицуулалт';
  const application =
    intent === 'labor'
      ? 'ажил олгогчийн шийдвэр хууль ёсны эсэх, ажилтны шаардлага ямар баримтаар нотлогдохыг шалгахад хэрэглэгдэнэ'
      : intent === 'traffic'
        ? 'ослын дараах үүрэг, хохирол тогтоох дараалал, даатгал болон хариуцлагын асуудлыг тодруулахад хэрэглэгдэнэ'
        : intent === 'contract'
          ? 'гэрээний үүрэг, төлбөр, хугацаа хэтрэлт, хохирол болон шаардлага гаргах үндэслэлийг тодруулахад хэрэглэгдэнэ'
          : intent === 'crime'
            ? 'гомдол гаргах, нотлох баримт бүрдүүлэх, хариуцлагын шинжийг шалгуулахад хэрэглэгдэнэ'
            : 'таны нөхцөлд ямар эрх, үүрэг, шаардлага үүсэхийг тодруулахад хэрэглэгдэнэ';
  return `${ref.citation} нь ${label} тухай заалт бөгөөд ${application}.`;
}

function buildQaLawExplanationText(
  query: string,
  intent: QueryIntent,
  chunks: ChromaQueryResult[],
  allowedArticles: string[] = [],
): string {
  const refs = collectQaReferences(query, chunks).slice(0, 3);
  const sentences: string[] = [buildQaLawExplanationIntro(intent, query)];
  for (const ref of refs) {
    sentences.push(buildReferenceExplanationSentence(ref, intent));
  }

  if (refs.length === 0 && allowedArticles.length > 0) {
    sentences.push(
      `${allowedArticles.slice(0, 3).join(', ')} дугаар зүйлүүдийг хэрэглэхдээ зөвхөн дугаар харах бус, тухайн заалт таны бодит нөхцөлд ямар үүрэг, шаардлага, хугацаа үүсгэж байгааг шалгах хэрэгтэй.`,
    );
  }

  for (const addition of intentLawExplanationAdditions(intent, query)) {
    if (countSentences(sentences.join(' ')) >= 5) {
      break;
    }
    sentences.push(addition);
  }

  while (countSentences(sentences.join(' ')) < 5) {
    sentences.push(
      'Хэрэв эх сурвалжид яг тохирох тусгай нөхцөл дутуу байвал буруу зүйл, заалт зохиохын оронд баримтаа бүрдүүлж, эрх бүхий байгууллагаас бичгээр тодруулга авах нь илүү найдвартай.',
    );
  }

  return sentences.join(' ');
}

function ensureLawExplanationText(
  existing: string,
  query: string,
  intent: QueryIntent,
  chunks: ChromaQueryResult[],
  allowedArticles: string[] = [],
): string {
  if (
    existing.trim() &&
    countSentences(existing) >= 5 &&
    !isDryLawExplanation(existing) &&
    !hasOcrOrInternalLeakage(existing)
  ) {
    return existing.trim();
  }

  return buildQaLawExplanationText(query, intent, chunks, allowedArticles);
}

function ensureRiskText(existing: string, intent: QueryIntent, query: string): string {
  const cleaned = stripMarkdownForCounting(existing);
  const base = cleaned.length > 0 ? cleaned : buildQaRiskGuidance(intent, query);
  if (countSentences(base) >= 2) {
    return base;
  }

  const addition =
    intent === 'labor'
      ? 'Халагдсан тушаал, гардуулсан огноо, ажил олгогчийн үндэслэл тодорхойгүй байвал гомдол гаргах хугацаа болон нотолгооны асуудал хүндрэх эрсдэлтэй.'
      : intent === 'traffic'
        ? 'Ослын газрын зураг, цагдаагийн бүртгэл, даатгалын мэдэгдэл дутуу бол хохирол нөхөн төлүүлэх ажиллагаа удаашрах эсвэл татгалзагдах эрсдэлтэй.'
        : intent === 'contract'
          ? 'Гэрээ, төлбөрийн тооцоо, бичгээр өгсөн шаардлага дутуу бол нэхэмжлэлийн дүн болон үндэслэл маргаантай болж, хэрэг удаашрах эрсдэлтэй.'
          : 'Баримт дутуу, хугацаа алдсан, шаардлага тодорхой бус байвал эрхээ хамгаалах ажиллагаа удаашрах эсвэл хэсэгчлэн хэрэгсэхгүй болох эрсдэлтэй.';
  return `${base.replace(/[.!?。！？]*$/u, '.')} ${addition}`;
}

function buildStructuredQaContractAnswer(params: {
  query: string;
  intent: QueryIntent;
  chunks: ChromaQueryResult[];
  allowedArticles?: string[];
  baseAnswer?: string;
}): string {
  const { query, intent, chunks, allowedArticles = [], baseAnswer = '' } = params;
  const sections = extractQaAnswerSections(baseAnswer);
  const advice = ensureAdviceText(sections.advice, intent, query);
  const actions = ensureMinimumActionSteps(sections.actions, intent, query);
  const lawExplanation = ensureLawExplanationText(
    sections.lawExplanation,
    query,
    intent,
    chunks,
    allowedArticles,
  );
  const risks = ensureRiskText(sections.risks, intent, query);
  const tips = ensureMinimumPracticalTips(sections.practicalTips, intent, query);

  return [
    '**Зөвлөгөө**',
    advice,
    '',
    '**Яг одоо хийх алхам**',
    ...actions.map((step, idx) => `${idx + 1}. ${step}`),
    '',
    '**Хуулийн тайлбар**',
    lawExplanation,
    '',
    '**Анхаарах эрсдэл**',
    risks,
    '',
    '**Практик зөвлөгөө**',
    ...tips.map((tip) => `- ${tip}`),
  ].join('\n');
}

function ensureQaGenerationResultContract(
  result: GenerationResult,
  intent: QueryIntent,
  query: string,
  chunks: ChromaQueryResult[] = [],
  allowedArticles: string[] = [],
): GenerationResult {
  if (result.mode === 'no-info' || result.answer.trim() === NO_INFO_RESPONSE) {
    return result;
  }

  return {
    ...result,
    answer: appendLegalInformationDisclaimer(
      buildStructuredQaContractAnswer({
        query,
        intent,
        chunks,
        allowedArticles,
        baseAnswer: result.answer,
      }),
      'qa',
    ),
  };
}

function appendLegalInformationDisclaimer(answer: string, mode: QueryMode): string {
  const trimmed = answer.trim();
  if (!trimmed || trimmed === NO_INFO_RESPONSE || mode !== 'qa') {
    return answer;
  }

  if (trimmed.includes(LEGAL_INFORMATION_DISCLAIMER)) {
    return trimmed;
  }

  return `${trimmed}\n\n${LEGAL_INFORMATION_DISCLAIMER}`;
}

/**
 * Detects raw OCR-style law dumps ("Хууль: NAME Зүйл: NUM ...") and internal
 * pipeline jargon that must never reach the user. Centralised so we can run it
 * both before swapping to the structured fallback and during post-processing.
 */
function hasOcrOrInternalLeakage(answer: string): boolean {
  if (!answer) {
    return false;
  }

  const internalJargon =
    /(LLM\s+үйлчилгээ|Доорх\s+контекст|Контекстэд\s+(?:давтагдсан|баталгаатайгаар)|retrieval|source\s+score|chunk\s+score|системийн\s+дотоод|Эх\s+сурвалж\s*\d+\s*\])/iu;
  if (internalJargon.test(answer)) {
    return true;
  }

  // "Хууль: <text> Зүйл: <num>" preprocessor prefix copied verbatim from chunks.
  if (/Хууль\s*[:：]\s*[^.\n]{3,200}?\s+Зүйл\s*[:：]/iu.test(answer)) {
    return true;
  }

  // "Зүйл: 1661 МӨНГӨ УГААХ" style dumps where the article header includes the
  // raw all-caps title from the source.
  if (/Зүйл\s*[:：]\s*\d+(?:\.\d+)?\s+[А-ЯӨҮЁ]{4,}/u.test(answer)) {
    return true;
  }

  // All-caps law title immediately followed by ":" or "—" and "Хууль"/"Зүйл"
  // (LLM literally pasting the [Эх сурвалж N] header line back to the user).
  if (
    /[А-ЯӨҮЁ]{4,}(?:[А-ЯӨҮЁ\s,/()"'«».-]{2,160}[А-ЯӨҮЁ]{2,})?\s*[:：—]\s*(?:Хууль|Зүйл)\s*[:：]/iu.test(
      answer,
    )
  ) {
    return true;
  }

  return false;
}

type QaReference = {
  /** Compact citation chip in markdown form, e.g. [ХТ-ийн §128](url) */
  citation: string;
  /** Short human label (1 sentence, <= 120 chars) explaining what the article covers */
  shortLabel: string;
  /** Full verbose summary kept for scenario fallbacks that still need raw excerpts */
  summary: string;
};

function ensureLegalLinksInAnswer(
  answer: string,
  query: string,
  chunks: ChromaQueryResult[],
): string {
  const trimmed = answer.trim();
  if (
    !trimmed ||
    trimmed === NO_INFO_RESPONSE ||
    /legalinfo\.mn\/mn\/detail\?lawId=/i.test(trimmed)
  ) {
    return answer;
  }

  const citations = collectQaReferences(query, chunks)
    .map((ref) => ref.citation)
    .filter((citation) => /legalinfo\.mn\/mn\/detail\?lawId=/i.test(citation))
    .slice(0, 3);

  if (citations.length === 0) {
    return answer;
  }

  return [
    trimmed,
    '',
    '**Эх сурвалжийн холбоос**',
    ...citations.map((citation, index) => `${index + 1}. ${citation}`),
  ].join('\n');
}

export function cleanupAnswerStructure(answer: string): string {
  const ocrStripped = stripOcrLeakage(answer);
  const lines = ocrStripped.split(/\r?\n/);
  const cleaned: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i]?.trim() ?? '';

    if (/^\d+$/.test(current)) {
      continue;
    }

    if (
      cleaned.length > 0 &&
      current.replace(/\*\*/g, '') === 'Практик зөвлөгөө' &&
      cleaned[cleaned.length - 1].replace(/\*\*/g, '') === 'Практик зөвлөгөө'
    ) {
      continue;
    }

    const normalizedCurrent = current
      .replace(/^\d+\.\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isDuplicateMeaningfulLine =
      normalizedCurrent.length >= 32 &&
      cleaned.some(
        (line) =>
          line
            .trim()
            .replace(/^\d+\.\s*/, '')
            .replace(/\s+/g, ' ')
            .toLowerCase() === normalizedCurrent,
      );

    if (isDuplicateMeaningfulLine) {
      continue;
    }

    if (
      /^(?:Контекстэд давтагдсан|Контекстэд баталгаатайгаар|Контекст сул үед|retrieval|source score|LLM\s+үйлчилгээ|Доорх\s+контекст|\[Эх\s+сурвалж\s*\d+)/i.test(
        current,
      ) ||
      /Контекстэд баталгаатайгаар/i.test(current)
    ) {
      continue;
    }

    cleaned.push(lines[i] ?? '');
  }

  return cleaned
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Removes OCR/preprocessor leakage that the LLM sometimes copies verbatim from
 * the retrieved chunks. Operates line-by-line so we strip individual offending
 * lines without breaking the surrounding markdown structure.
 *
 * Patterns removed:
 *   - "Хууль: <NAME> Зүйл: <num>" preprocessor headers
 *   - "Зүйл: 1661 МӨНГӨ УГААХ" raw all-caps article headers
 *   - "LLM үйлчилгээ түр боломжгүй..." / "Доорх контекстээс олдсон..." pipeline jargon
 *   - "[Эх сурвалж N] ..." retrieval debug headers
 *
 * Embedded inside a longer line (e.g. inline reference list) the OCR fragment
 * is replaced with a soft separator so the surrounding sentence stays
 * grammatical.
 */
export function stripOcrLeakage(answer: string): string {
  if (!answer) {
    return answer;
  }

  const lineFilters: RegExp[] = [
    /^\s*LLM\s+үйлчилгээ.*$/iu,
    /^\s*Доорх\s+контекст[^\n]*$/iu,
    /^\s*\[Эх\s+сурвалж\s*\d+\]?[^\n]*$/iu,
    /^\s*Хууль\s*[:：]\s*[А-ЯӨҮЁ][^\n]{0,200}\s+Зүйл\s*[:：][^\n]*$/iu,
  ];

  const inlineReplacements: Array<{ pattern: RegExp; replacement: string }> = [
    // "Хууль: NAME Зүйл: NUM TITLE-IN-CAPS" embedded inline
    {
      pattern:
        /Хууль\s*[:：]\s*[^\n.,;]{3,200}?\s+Зүйл\s*[:：]\s*\d+(?:\.\d+)?(?:\s+[А-ЯӨҮЁ][А-ЯӨҮЁ\s,/()"'«».-]{2,160})?/giu,
      replacement: '',
    },
    // "Зүйл: 1661 МӨНГӨ УГААХ" inline (when not the start of a structured ref line)
    {
      pattern: /Зүйл\s*[:：]\s*\d+(?:\.\d+)?\s+[А-ЯӨҮЁ]{4,}[А-ЯӨҮЁ\s,/()"'«».-]{0,160}/giu,
      replacement: '',
    },
    // "LLM үйлчилгээ түр боломжгүй..." / "Доорх контекстээс" inline
    {
      pattern: /(LLM\s+үйлчилгээ[^.\n]*\.|Доорх\s+контекст[^.\n]*\.)/giu,
      replacement: '',
    },
  ];

  const linesIn = answer.split(/\r?\n/);
  const linesOut: string[] = [];

  for (const original of linesIn) {
    if (lineFilters.some((rx) => rx.test(original))) {
      continue;
    }

    let next = original;
    for (const { pattern, replacement } of inlineReplacements) {
      next = next.replace(pattern, replacement);
    }

    next = next.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');

    if (next.trim() === '' && original.trim() !== '') {
      // The whole line was OCR leakage; drop it instead of leaving a blank.
      continue;
    }

    linesOut.push(next);
  }

  return linesOut
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cleans the raw chunk body before it is injected into the LLM prompt. The
 * preprocessor that produced the embeddings prepended each chunk with
 * "Хууль: <NAME> Зүйл: <num> <ARTICLE TITLE IN CAPS>" plus various structural
 * artefacts. The LLM occasionally copies that verbatim into the answer, so we
 * strip it here at the prompt boundary.
 *
 * The header line ([Эх сурвалж N] ...) is built separately by
 * buildContextBlock from clean metadata.
 */
export function cleanChunkDocumentForPrompt(text: string): string {
  if (!text) {
    return '';
  }

  let body = text.replace(/\r/g, '').trim();

  // Drop the leading "Хууль: <name> Зүйл: <num> <CAPS TITLE>" preprocessor prefix.
  body = body.replace(
    /^Хууль\s*[:：]\s*[^\n]{3,300}?\s+Зүйл\s*[:：]\s*\d+(?:\.\d+)?(?:\s+[А-ЯӨҮЁ][А-ЯӨҮЁ\s,/()"'«».-]{2,200})?\s*/iu,
    '',
  );

  // Inline duplicates if the OCR header repeats further down the chunk body.
  body = body.replace(
    /Хууль\s*[:：]\s*[^\n.,;]{3,200}?\s+Зүйл\s*[:：]\s*\d+(?:\.\d+)?(?:\s+[А-ЯӨҮЁ][А-ЯӨҮЁ\s,/()"'«».-]{2,200})?/giu,
    '',
  );

  // Collapse runs of whitespace introduced by the strip.
  body = body
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return body;
}

function buildQaOpeningAdvice(intent: QueryIntent, query: string): string {
  if (intent === 'traffic') {
    return 'Зам тээврийн ослын үед хамгийн түрүүнд хүний аюулгүй байдлыг хангаж, ослын газрыг хамгаалж, цагдаа болон даатгалд албан ёсоор мэдэгдэнэ. Дараа нь хохирол, буруутай эсэх, даатгалын нөхөн төлбөр, зөрчил эсвэл эрүүгийн хариуцлага үүсэх эсэхийг баримтаар тогтоолгоно.';
  }

  if (intent === 'labor') {
    return 'Хөдөлмөрийн маргаанд ажлаас халсан тушаал, хөдөлмөрийн гэрээ, цалингийн баримт, ажил олгогчийн албан хариу хамгийн чухал нотолгоо болдог. Эхлээд бүх бичгийн баримтаа цуглуулж, дараа нь дотоод гомдол, хөдөлмөрийн маргаан шийдвэрлэх шат, шүүхийн журмаар эрхээ хамгаална.';
  }

  if (intent === 'contract' && isBankLoanQuery(query)) {
    return 'Банк, зээлийн асуудалд аман тохиролцооноос илүү гэрээ, эргэн төлөлтийн хуваарь, банкны тооцоолол, бичгээр өгсөн мэдэгдэл шийдвэрлэх ач холбогдолтой. Эхлээд төлөх дүнг задалсан тооцоог бичгээр авч, дараа нь хугацаа сунгах, дахин хуваарьлах, маргах үндэслэлээ баримтаар гаргана.';
  }

  if (intent === 'family') {
    return 'Гэр бүлийн маргаанд хүүхдийн эрх ашиг, бодит асрамж, орлого, оршин суугаа нөхцөл, өмнөх тохиролцоо зэрэг баримт хамгийн чухал. Маргааныг эхлээд эвлэрлийн болон бичгийн хэлбэрээр шийдэхийг оролдож, болохгүй бол шүүхэд нотолгоотой хандана.';
  }

  if (intent === 'crime') {
    return 'Эрүүгийн шинжтэй асуудалд баримтаа алдахгүй хадгалж, цагдаад гомдол мэдээлэл гаргах нь хамгийн эхний алхам. Хохирол, үйлдэл, санаа зорилго, нотлох баримт тодорхой байж гэмт хэрэг эсэх болон хариуцлагын асуудал шийдэгдэнэ.';
  }

  if (/гэрээ|өр|төлбөр|хохирол|нэхэмж/i.test(query)) {
    return 'Иргэний болон гэрээний маргаанд гэрээний нөхцөл, төлбөрийн баримт, мэдэгдэл хүргүүлсэн огноо, хохирлын тооцоо хамгийн чухал байдаг. Эхлээд шаардлагаа бичгээр тодорхой болгож, дараа нь эвлэрэл эсвэл шүүхийн журмаар шаардана.';
  }

  return 'Асуудлыг шийдэхдээ эхлээд бодит баримтаа цуглуулж, холбогдох байгууллага эсвэл нөгөө талд бичгээр хандаж, дараа нь хуулийн үндэслэлээ тодорхой зааж шаардлага гаргах нь зөв.';
}

function buildQaLawExplanationIntro(intent: QueryIntent, query: string): string {
  if (intent === 'traffic') {
    return 'Зам тээврийн ослын асуудалд жолоочийн үүрэг, ослын дараах баримтжуулалт, хохирол нөхөн төлүүлэх, даатгалын нөхөн төлбөр, зөрчлийн болон эрүүгийн хариуцлагын зааг хамт яригддаг. Иймээс зөвхөн “осол гарсан” гэдгээр бус, хүн гэмтсэн эсэх, согтууруулах ундаа хэрэглэсэн эсэх, ослын газраас явсан эсэх, хохирлын хэмжээ, цагдаад бүртгүүлсэн эсэхээр эрх зүйн үр дагавар өөрчлөгдөнө.';
  }

  if (intent === 'labor') {
    return 'Хөдөлмөрийн харилцаанд хууль нь ажилтны эрх, ажил олгогчийн үүрэг, ажлаас чөлөөлөх үндэслэл, цалин хөлс, сахилгын шийтгэл, маргаан шийдвэрлэх журмыг тогтоодог. Тиймээс тушаал хууль ёсны эсэхийг гэрээ, дотоод журам, ажил олгогчийн үндэслэл, нотлох баримттай нь хамтад нь шалгана.';
  }

  if (intent === 'contract' && isBankLoanQuery(query)) {
    return 'Зээлийн харилцаанд хууль нь зээлийн гэрээ, хүү, нэмэгдүүлсэн хүү, алданги, барьцаа, хугацаа хэтрэхэд үүсэх үр дагаврыг зохицуулдаг. Банк ямар төлбөр шаардаж болох нь гэрээний заалт болон тухайн тооцоолол хуульд нийцэж байгаа эсэхээс хамаарна.';
  }

  if (intent === 'crime') {
    return 'Эрүүгийн асуудалд үйлдэл, санаа зорилго, хохирлын хэмжээ, нотлох баримт, хохирогчийн мэдүүлэг, мөрдөн шалгах ажиллагааны үр дүнгээр хариуцлага тогтоогдоно. Иймээс эхлээд баримтаа хамгаалж, албан ёсоор шалгуулах нь хамгийн чухал.';
  }

  if (/гэрээ|өр|төлбөр|хохирол|нэхэмж/i.test(query)) {
    return 'Иргэний эрх зүйн маргаанд гэрээний үүрэг, үүргээ биелүүлээгүй хугацаа, хохирлын хэмжээ, мэдэгдэл өгсөн эсэх, төлбөрийн баримт зэрэг нь нэхэмжлэл гаргах үндэслэл болдог. Шүүхэд хандахдаа шаардлага, тооцоо, нотлох баримтаа тодорхой гаргах шаардлагатай.';
  }

  return 'Энэ төрлийн асуудалд ямар хууль хэрэглэх нь бодит үйл баримт, баримтжуулалт, хугацаа, хандсан байгууллага, үүссэн хохирол зэргээс хамаарна. Доорх заалтуудыг таны нөхцөлтэй тулгаж хэрэглэх боломжтой.';
}

function isUsableTrafficReferenceText(text: string): boolean {
  const normalized = normalizeForMatch(text);
  if (
    /(улсын\s+бүртгэлийн\s+дугаар|техникийн\s+үйлчилгээ|жолоочоос\s+бусад|нэр\s+томьёо|шүүрт\s+худгийн\s+таг|зам\s+дээр\s+хийгдсэн\s+үзлэг)/i.test(
      normalized,
    )
  ) {
    return false;
  }

  return /(жолооч|осол|мөргөл|хохирол|даатгал|замын\s+хөдөлгөөн|зөрчил|тээврийн\s+хэрэгсэл|согтуур)/i.test(
    normalized,
  );
}

type TrafficScenario =
  | 'general'
  | 'dui'
  | 'collision'
  | 'opposite_lane_collision'
  | 'hit_and_run'
  | 'parking_collision'
  | 'parking_hit_and_run';

function buildDetailedQaFallbackFromContext(
  query: string,
  chunks: ChromaQueryResult[],
  intent: QueryIntent,
  allowedArticles: string[],
): { answer: string; confidence: number } {
  return {
    answer: buildStructuredQaContractAnswer({
      query,
      intent,
      chunks,
      allowedArticles,
    }),
    confidence: 0.68,
  };
}

function buildTrafficIncidentFallback(
  query: string,
  chunks: ChromaQueryResult[],
): { answer: string; confidence: number } {
  const refs = collectQaReferences(query, chunks)
    .filter((ref) => isUsableTrafficReferenceText(ref.summary))
    .slice(0, 3);
  const lawLines =
    refs.length > 0
      ? formatCompactReferenceLines(refs)
      : [
          '1. Замын хөдөлгөөний аюулгүй байдлын тухай хууль болон Замын хөдөлгөөний дүрмийн жолоочийн үүргийн зохицуулалт — осол гарсан үед хүний аюулгүй байдлыг хангах, ослын газрыг хамгаалах, цагдаад мэдэгдэх, баримт бүрдүүлэх суурь үүргийг тодорхойлдог.',
          '2. Зөрчлийн тухай хуулийн замын хөдөлгөөний зөрчилтэй холбоотой зохицуулалт — хүн гэмтээгүй, хохирлын шинжтэй осол бол зөрчлийн журмаар шалгагдах боломжтой.',
          '3. Иргэний хуулийн гэм хорын зохицуулалт — бусдын эд хөрөнгөд учруулсан хохирлыг буруутай этгээдээр нөхөн төлүүлэх үндэслэл болдог.',
        ].join('\n\n');

  const answer = [
    '**Зөвлөгөө**',
    'Зам тээврийн осол гаргасан бол хамгийн түрүүнд хүний аюулгүй байдлыг хангаж, ослын газрыг хамгаалж, цагдаа болон даатгалд мэдэгдэх хэрэгтэй. Дараа нь хохирол, буруутай эсэх, даатгалын нөхөн төлбөр, зөрчил эсвэл эрүүгийн хариуцлага үүсэх эсэхийг албан баримтаар тогтоолгоно.',
    '',
    '**Яг одоо хийх алхам**',
    '1. Хүн гэмтсэн эсэхийг шалгаж, гэмтсэн бол 103 болон 102-т шууд мэдэгдэнэ.',
    '2. Тээврийн хэрэгслийн байрлал, мөргөлдсөн цэг, эвдрэл, замын тэмдэг, гэрлэн дохио, орчны нөхцөлийг зураг, видео, дэшкам, гэрчээр баримтжуулна.',
    '3. Ослын газрыг дур мэдэн орхихгүй, цагдаагийн бүртгэл, ослын схем, тодорхойлолтыг гаргуулна.',
    '4. Даатгалтай бол гэрээнд заасан хугацаанд даатгагчдаа мэдэгдэж, хохирлын үнэлгээ, засварын төсөв, акт зэргийг бүрдүүлнэ.',
    '',
    '**Хуулийн тайлбар**',
    'Зам тээврийн ослын асуудалд жолоочийн үүрэг, ослын дараах баримтжуулалт, хохирол нөхөн төлүүлэх, даатгалын нөхөн төлбөр, зөрчлийн болон эрүүгийн хариуцлагын зааг хамт яригддаг. Хүн гэмтсэн эсэх, согтуугаар жолоодсон эсэх, ослын газраас явсан эсэх, хохирлын хэмжээ, цагдаад бүртгүүлсэн эсэхээс хамаарч шийдвэрлэх журам өөрчлөгдөнө.',
    '',
    lawLines,
    '',
    '**Анхаарах эрсдэл**',
    'Ослын газрыг орхих, цагдаад бүртгүүлэхгүй байх, даатгалд хугацаанд нь мэдэгдэхгүй байх, эвдрэлээ засварлуулсны дараа зураг баримтгүй үлдэх зэрэг нь хохирол нөхүүлэх болон өөрийгөө хамгаалах боломжийг сулруулна. Хүн гэмтсэн, согтууруулах ундаа хэрэглэсэн, эсвэл их хэмжээний хохирол учирсан бол зөвхөн даатгалын маргаан биш, зөрчил эсвэл эрүүгийн хариуцлагын асуудал үүсэж болно.',
    '',
    '**Практик зөвлөгөө**',
    '- Ослын дараа машиныг хөдөлгөхөөс өмнө 4 талаас нь зураг авч, ойр орчны камер, гэрчийн мэдээллийг хадгал.',
    '- Цагдаагийн тэмдэглэл, ослын схем, даатгалын мэдэгдэл, хохирлын үнэлгээ, засварын баримтыг нэг хавтаст багцал.',
    '- Даатгал эсвэл нөгөө талтай аман тохиролцоонд найдахгүй, бүх хүсэлт, татгалзлыг бичгээр ав.',
  ].join('\n');

  return { answer, confidence: refs.length > 0 ? 0.74 : 0.68 };
}

function buildTrafficInsuranceClaimFallback(
  query: string,
  chunks: ChromaQueryResult[],
): GenerationResult {
  const refs = collectQaReferences(query, chunks).slice(0, 4);
  const referenceLines =
    refs.length > 0
      ? formatCompactReferenceLines(refs)
      : '1. Даатгалын гэрээ, нөхөн төлбөрөөс татгалзсан үндэслэл, хохирол нотлох баримтаа бичгээр шалгуулах шаардлагатай.';

  const answer = [
    'Даатгалын компани “камерын бичлэг байхгүй” гэдэг ганц шалтгаанаар нөхөн төлбөрийг шууд хаах ёсгүй. Ослын нөхцөл, хохирлын хэмжээ, даатгалын тохиолдол болсон эсэхийг цагдаагийн тэмдэглэл, ослын схем, тээврийн хэрэгслийн гэмтлийн зураг, засварын үнэлгээ, гэрчийн тайлбар, жолооч нарын мэдүүлэг зэрэг бусад баримтаар тогтоож болно.',
    '',
    '**Яг одоо хийх алхам**',
    '1. Даатгалын компаниас татгалзсан үндэслэлээ гэрээний аль заалт, ямар баримт дутуу гэж үзсэнээр тайлбарласан албан бичиг гаргуулж ав.',
    '2. Ослын тухай цагдаагийн бүртгэл, ослын схем, эвдрэлийн зураг, засварын үнэлгээ, даатгалд анх мэдэгдсэн огноо, даатгалтай харилцсан бүх мессеж болон имэйлийг нэг багц болго.',
    '3. “Камер байхгүй боловч осол болон хохирол эдгээр баримтаар тогтоогдоно” гэж тодорхой бичээд 7-14 хоногийн дотор дахин шийдвэрлэхийг шаардсан хүсэлт өг.',
    '4. Хариу өгөхгүй эсвэл үндэслэлгүй татгалзвал Санхүүгийн зохицуулах хороо болон шүүхэд нөхөн төлбөр, үнэлгээний зардал, шаардлагатай бол нэмэлт хохирлоо нэхэмжлэх боломжтой.',
    '',
    '**Хуулийн үндэслэл**',
    referenceLines,
    '',
    '**Анхаарах эрсдэл**',
    'Даатгалын гэрээнд ослыг мэдэгдэх хугацаа, бүрдүүлэх баримтын жагсаалт, нөхөн төлбөрөөс татгалзах нөхцөл туссан байдаг. Та хугацаандаа мэдэгдсэн бол 3 сар шийдвэрлэхгүй байгаа нь даатгагчийн үндэслэлгүй удаашруулалт байж болно. Харин анхны мэдэгдлийн хугацаа хоцорсон эсвэл ослын баримт огт бүрдээгүй бол маргаан хүндрэх тул бүх харилцаагаа бичгээр баримтжуул.',
    '',
    '**Практик зөвлөгөө**',
    '- “Татгалзсан тухай албан бичиггүйгээр” амаар хэлсэн тайлбарыг эцсийн шийдвэр гэж битгий хүлээн зөвшөөр.',
    '- Камер байхгүй бол зураг, засварын үнэлгээ, цагдаагийн бүртгэл, гэрч, ослын дараах дуудлага, даатгалд мэдэгдсэн огноо зэрэг орлох баримтаа жагсааж өг.',
    '- Даатгалд өгөх шаардлагадаа “ямар баримтыг хангалтгүй гэж үзсэн, ямар нэмэлт баримт шаардаж байгаа”-г тодорхой бичгээр тайлбарлахыг шаардаарай.',
  ].join('\n');

  return {
    answer,
    confidence: refs.length > 0 ? 0.78 : 0.66,
    promptTokens: 0,
    completionTokens: 0,
    mode: refs.length > 0 ? 'context' : 'fallback-general',
    suggestedQuestions: [
      'Даатгалын компанид өгөх албан шаардлагын загвар бичиж өгөх үү?',
      'Цагдаагийн актгүй бол ослыг өөр ямар баримтаар нотлох вэ?',
      'Даатгал нөхөн төлбөрөөс татгалзвал шүүхэд ямар материал бүрдүүлэх вэ?',
    ],
  };
}

function buildBankLoanOverdueFallback(
  query: string,
  chunks: ChromaQueryResult[],
): GenerationResult {
  const refs = collectQaReferences(query, chunks)
    .filter((ref) => /зээл|банк|хүү|хугацаа|үүрэг|барьцаа/i.test(ref.summary))
    .slice(0, 4);
  const referenceLines =
    refs.length > 0
      ? formatCompactReferenceLines(refs)
      : [
          '1. Иргэний хууль §451-452 орчим — банк, зээлийн үйл ажиллагаа эрхлэх эрх бүхий этгээдээс зээл олгох гэрээ болон зээлийн хүүгийн үндсэн зохицуулалт.',
          '2. Иргэний хууль §222, §232 орчим — үүрэг хугацаандаа биелүүлээгүй, анз/алданги тохирсон эсэхээс шалтгаалах иргэний эрх зүйн хариуцлагын суурь.',
          '3. Банк, эрх бүхий хуулийн этгээдийн мөнгөн хадгаламж, мөнгөн хөрөнгийн шилжүүлэг, зээлийн үйл ажиллагааны тухай хууль §20-21 орчим — зээлийн гэрээ, зээлийн хүү, банкны зээлийн ажиллагааны тусгай зохицуулалт.',
        ].join('\n\n');

  const answer = [
    'Банкнаас авсан зээлийг 2 сар төлөөгүй байгаа нь ердийн нөхцөлд шууд эрүүгийн ял биш, харин зээлийн гэрээний үүргээ хугацаанд нь биелүүлээгүй иргэний эрх зүйн маргаан гэж эхэлж үнэлэгдэнэ. Гэхдээ гэрээнд нэмэгдүүлсэн хүү, алданги, барьцаа, хугацаанаас өмнө бүх зээлийг шаардах нөхцөл туссан бол таны төлөх дүн өсөх, банк шүүхэд нэхэмжлэл гаргах, барьцаа хэрэгжүүлэх эрсдэл үүснэ.',
    '',
    '**Яг одоо хийх алхам**',
    '1. Банкнаас үндсэн зээлийн үлдэгдэл, гэрээний хүү, нэмэгдүүлсэн хүү, алданги, шимтгэл тус бүрийг салгасан тооцооллыг бичгээр ав.',
    '2. Зээлийн гэрээ, эргэн төлөлтийн хуваарь, барьцааны гэрээ, банкнаас ирсэн мэдэгдэл, мессеж, имэйлийг нэг багц болго.',
    '3. Одоогоор төлөх боломжгүй бол “хугацаа сунгах, хэсэгчлэн төлөх, дахин хуваарьлах” хүсэлтээ амаар биш бичгээр гаргаж, хариуг нь хадгал.',
    '4. Банк шүүхэд өгсөн, эсвэл барьцаа хэрэгжүүлэх мэдэгдэл ирсэн бол хугацаа алдалгүй бичгээр хариу тайлбар гаргаж, тооцоолол дээр маргах зүйл байвал тусад нь тэмдэглэ.',
    '',
    '**Хуулийн үндэслэл**',
    referenceLines,
    '',
    '**Анхаарах эрсдэл**',
    'Хоёр сар хоцорсон гэдэг нь ихэвчлэн “зээл төлөх чадваргүй болсон” нөхцөл байдлын эхний шат боловч гэрээний нөхцөлөөс хамаараад банк нэмэгдүүлсэн хүү, алданги тооцох, зээлийг хугацаанаас өмнө бүхэлд нь шаардах, зээлийн мэдээллийн санд сөрөг мэдээлэл бүртгүүлэх, барьцаатай бол барьцаа хөрөнгөд шаардлага гаргах боломжтой. Харин зээл авахдаа хуурамч бичиг баримт бүрдүүлсэн, анхнаасаа төлөх санаагүй залилсан шинжтэй бол эрүүгийн асуудал тусдаа яригдаж болно.',
    '',
    '**Практик зөвлөгөө**',
    '- Банкны ажилтантай ярьсан аман тохиролцоонд найдахгүй, төлбөрийн шинэ санал болон банкны хариуг заавал бичгээр ав.',
    '- Тооцоолол дээр маргахдаа “үндсэн зээл, хүү, нэмэгдүүлсэн хүү, алданги” гэж тус тусад нь салгаж шалга.',
    '- Боломжтой бол бага дүнгээр ч хэсэгчлэн төлөх санал гаргаж, төлбөрөөс бүрэн зайлсхийх биш шийдвэрлэх оролдлого хийж байгаагаа баримтжуул.',
  ].join('\n');

  return {
    answer,
    confidence: refs.length > 0 ? 0.78 : 0.64,
    promptTokens: 0,
    completionTokens: 0,
    mode: refs.length > 0 ? 'context' : 'fallback-general',
    suggestedQuestions: [
      'Зээлийн гэрээнд нэмэгдүүлсэн хүү, алданги хэрхэн бичигдсэнийг яаж шалгах вэ?',
      'Банк зээлийг хугацаанаас өмнө бүхэлд нь шаардаж болох уу?',
      'Барьцаатай зээлийг төлөөгүй бол банк ямар дарааллаар барьцаа хэрэгжүүлэх вэ?',
    ],
  };
}

function buildCyberFraudFallback(query: string, chunks: ChromaQueryResult[]): GenerationResult {
  const refs = collectQaReferences(query, chunks)
    .filter((ref) =>
      /зали|луйвар|нотлох|цагдаа|хохирогч|харилцаа холбоо|эрүүгийн/i.test(ref.summary),
    )
    .slice(0, 4);
  const referenceLines =
    refs.length > 0
      ? formatCompactReferenceLines(refs)
      : [
          '1. Эрүүгийн хууль дахь залилах гэмт хэргийн зохицуулалт нь бусдыг хууран мэхэлж мөнгө, эд хөрөнгө шилжүүлэн авсан нөхцөлд шалгагдах үндсэн суурь болно.',
          '2. Эрүүгийн хэрэг хянан шийдвэрлэх ажиллагаанд чат, шилжүүлгийн баримт, дансны мэдээлэл, дуудлага, линк, төхөөрөмжийн мэдээлэл зэрэг нь нотлох баримтын ач холбогдолтой.',
          '3. Цагдаагийн байгууллагад гомдол гаргахдаа мөнгө шилжсэн данс, огноо, дүн, харилцсан хүний нэр/утас/линк, бүх screenshot-оо хавсаргах хэрэгтэй.',
        ].join('\n\n');

  const answer = [
    'Цахим луйварт өртсөн бол хамгийн түрүүнд мөнгөний урсгалыг зогсоох, баримтаа устгахгүй хадгалах, цагдаад албан ёсоор гомдол гаргах гурван алхмыг зэрэг хийх хэрэгтэй. Чат устгах, аккаунтыг блоклоод орхих, эсвэл зөвхөн банк руу залгаад хүлээх нь нотолгоо алдагдуулах эрсдэлтэй.',
    '',
    '**Яг одоо хийх алхам**',
    '1. Мөнгө шилжүүлсэн бол өөрийн банк руу шууд залгаж гүйлгээг маргаантай гэж бүртгүүлэх, хүлээн авагч данс руу цааш шилжихийг түр саатуулах боломж байгаа эсэхийг яаралтай асуу.',
    '2. 102 эсвэл харьяа цагдаагийн байгууллагад “цахим залилан/луйвар”-ын талаар гомдол гаргаж, шилжүүлгийн баримт, дансны дугаар, хүлээн авагчийн нэр, утас, чат, линк, зар, профайл, IP/имэйл байвал бүгдийг хавсарга.',
    '3. Чат, screenshot, банкны хуулга, дуудлагын түүх, мессеж, линкийг устгалгүй хадгалж, файл бүрийн огноо цагийг хэвээр үлдээ. Боломжтой бол PDF эсвэл зураг хэлбэрээр давхар хадгал.',
    '4. Нууц үг, банкны апп, и-мэйл, сошиал аккаунтын нууц үгээ солиод хоёр шатлалт хамгаалалт идэвхжүүл. OTP код, картын мэдээлэл алдсан бол картаа хаалга.',
    '5. Хэрэв таны нэрээр өөр хүн зээл, данс, гэрээ нээсэн байж болзошгүй бол банк болон холбогдох үйлчилгээ үзүүлэгчээс бичгээр лавлагаа авч, цагдаагийн гомдолдоо нэмэлтээр өг.',
    '',
    '**Хуулийн үндэслэл**',
    referenceLines,
    '',
    '**Анхаарах эрсдэл**',
    'Цахим луйврын үед хугацаа хамгийн чухал. Гүйлгээ хэд хэдэн дансаар дамжих, чат устах, хуурамч профайл хаагдах, линк идэвхгүй болохоос өмнө банк, цагдаад зэрэг мэдэгдэх хэрэгтэй. Хэрэв та OTP код, банкны нууц үг, картын мэдээллээ өөрөө өгсөн байсан ч энэ нь шалгуулах эрхгүй гэсэн үг биш; харин баримтаа бүрэн өгөх шаардлага нэмэгдэнэ.',
    '',
    '**Практик зөвлөгөө**',
    '- Цагдаад өгөх өргөдөлдөө “хэн, хэзээ, ямар шалтгаанаар, ямар данс руу, хэдэн төгрөг шилжүүлсэн” гэдгийг нэг мөрөөр тодорхой бич.',
    '- Банкнаас гүйлгээний лавлагаа, хүлээн авагч дансны мэдээллийг хуульд нийцүүлэн шалгуулах хүсэлтээ бичгээр үлдээ.',
    '- Луйварчинтай дахин мөнгө шилжүүлэх, “мөнгө буцаая гэвэл төлбөр төл” гэх саналд хариу өгөхгүй; бүх харилцааг нотлох баримт болгон хадгал.',
  ].join('\n');

  return {
    answer,
    confidence: refs.length > 0 ? 0.78 : 0.66,
    promptTokens: 0,
    completionTokens: 0,
    mode: refs.length > 0 ? 'context' : 'fallback-general',
    suggestedQuestions: [
      'Цахим луйврын талаар цагдаад өгөх өргөдлийн загвар бичиж өгөх үү?',
      'Банк руу гүйлгээ саатуулах хүсэлтээ яаж бичгээр гаргах вэ?',
      'Цахим луйврын баримтыг ямар дарааллаар багцлах вэ?',
    ],
  };
}

function buildPhoneTheftFallback(query: string, chunks: ChromaQueryResult[]): GenerationResult {
  const refs = collectQaReferences(query, chunks)
    .filter((ref) =>
      /хулгай|цагдаа|эрэн|сурвалж|нотлох|харилцаа холбоо|imei|хохирогч|эрүүгийн/i.test(ref.summary),
    )
    .slice(0, 4);
  const referenceLines =
    refs.length > 0
      ? formatCompactReferenceLines(refs)
      : [
          '1. Гар утсыг нууцаар авсан, буцааж өгөхгүй завшсан, эсвэл худалдан борлуулсан байж болзошгүй бол хулгайлах болон эд хөрөнгөтэй холбоотой гэмт хэргийн шинжээр шалгуулна.',
          '2. Цагдаад гомдол гаргахдаа IMEI, серийн дугаар, худалдан авалтын баримт, дугаар, төхөөрөмжийн сүүлийн байршил, Find My/Find My Device-ийн мэдээлэл, камер болон гэрчийн мэдээллээ хавсаргана.',
          '3. Мөрдөн шалгах ажиллагаанд утасны сүлжээ, төхөөрөмж ашигласан байдал, зарын сайт эсвэл ломбард/худалдааны сувгаар борлуулсан эсэхийг шалгуулах боломжтой.',
        ].join('\n\n');

  const answer = [
    'Гар утсаа хулгайд алдсан бол эхний зорилго нь төхөөрөмжөө хамгаалах, баримтаа алдахгүй хадгалах, цагдаад албан ёсоор гомдол гаргах явдал юм. Зөвхөн “утсаа хайх” гэж оролдоод хугацаа алдвал камерын бичлэг устах, IMEI ашиглан шалгах боломж удаашрах эрсдэлтэй.',
    '',
    '**Яг одоо хийх алхам**',
    '1. Find My iPhone, Find My Device зэрэг холбогдсон хайлтын үйлчилгээгээр төхөөрөмжөө Lost mode/түгжих горимд оруулж, боломжтой бол сүүлийн байршлын screenshot ав.',
    '2. SIM картаа хаалгах эсвэл дахин гаргуулах талаар оператортоо мэдэгдэж, банкны апп, и-мэйл, сошиал хаягийн нууц үгээ сольж хоёр шатлалт хамгаалалт идэвхжүүл.',
    '3. IMEI, серийн дугаар, худалдан авалтын баримт, хайрцаг, утасны дугаар, алдсан газар/цаг, камер эсвэл гэрчийн мэдээллийг нэг багц болго.',
    '4. Харьяа цагдаагийн байгууллагад эсвэл 102-т хандаж “гар утас хулгайд алдсан” талаар гомдол гарга. Өргөдөлдөө төхөөрөмжийн мэдээлэл, алдсан нөхцөл, сэжигтэй этгээд/зар байвал заавал бич.',
    '5. Утсаа зарын сайт, фэйсбүүк групп, ломбард, засварын газар зэрэгт гарсан эсэхийг шалгахдаа өөрөө очиж маргалдахгүй; илэрсэн мэдээллээ screenshot хийж цагдаад өг.',
    '',
    '**Хуулийн үндэслэл**',
    referenceLines,
    '',
    '**Анхаарах эрсдэл**',
    'Утас алдагдсаны дараа SIM, банкны апп, и-мэйл хамгаалаагүй бол данс, хувийн мэдээлэл, зураг, сошиал хаяг давхар эрсдэлд орно. Хэрэв утсыг олсон хүн буцааж өгөхгүй ашигласан эсвэл зарсан бол энэ нь энгийн “гээгдүүлсэн” асуудлаас давж, эд хөрөнгөтэй холбоотой гэмт хэрэг эсвэл зөрчлийн шинжтэй байж болно.',
    '',
    '**Практик зөвлөгөө**',
    '- IMEI кодыг хайрцаг, худалдан авалтын баримт, операторын лавлагаа, төхөөрөмжийн өмнөх тохиргоо зэргээс олж цагдаад заавал өг.',
    '- Алдсан газрын камерын бичлэгийг 24-72 цагийн дотор устахаас өмнө хадгалуулах хүсэлт гарга.',
    '- Утсаа оллоо гэсэн хүнээс “урьдчилгаа төл” гэх санал ирвэл дахин луйварт өртөх эрсдэлтэй тул цагдаагийн оролцоогүйгээр мөнгө бүү шилжүүл.',
  ].join('\n');

  return {
    answer,
    confidence: refs.length > 0 ? 0.78 : 0.66,
    promptTokens: 0,
    completionTokens: 0,
    mode: refs.length > 0 ? 'context' : 'fallback-general',
    suggestedQuestions: [
      'Цагдаад өгөх гар утас хулгайд алдсан өргөдлийн загвар бичиж өгөх үү?',
      'IMEI кодоо хаанаас олж, яаж цагдаад өгөх вэ?',
      'Утсаар дамжсан банк, сошиал хаягаа яаж хамгаалах вэ?',
    ],
  };
}

function buildPublicNoiseFallback(chunks: ChromaQueryResult[]): GenerationResult {
  const refs = collectQaReferences('амгалан тайван байдал дуу чимээ', chunks).slice(0, 3);
  const referenceLines =
    refs.length > 0
      ? formatCompactReferenceLines(refs)
      : '1. Орон сууцны орчинд бусдын амгалан тайван байдлыг алдагдуулсан дуу чимээний асуудлыг ихэвчлэн зөрчлийн болон цагдаагийн байгууллагын гомдол, дуудлагын журмаар шалгуулна.';

  const answer = [
    'Шөнө орой хажуу айл, хөршөөс хэт их дуу чимээ гарч амгалан тайван байдал алдагдуулж байгаа бол эхлээд аюулгүй байдлаа хангаад, шууд маргалдахаас илүү цагдаа болон байрны хариуцсан байгууллагад баримттайгаар мэдэгдэх нь зөв. Нэг удаагийн дуу чимээ, давтагдсан шуугиан, согтуурал эсвэл хүчирхийллийн шинжтэй эсэхээс шалтгаалж авах арга хэмжээ өөр болно.',
    '',
    '**Яг одоо хийх алхам**',
    '1. Одоо үргэлжилж байгаа, унтах боломжгүй хэмжээнд хүрсэн бол 102-т дуудлага өгч, хаяг, давхар, айлын байршил, дуу чимээ үргэлжилж буй цагийг тодорхой хэл.',
    '2. Дуу чимээний бичлэг, цаг, давтамж, гэрчийн мэдээлэл, СӨХ эсвэл харуулд мэдэгдсэн тэмдэглэлээ хадгал.',
    '3. Хэрэв давтагддаг бол СӨХ, байрны контор, хөршийн холбоо эсвэл цагдаад бичгээр гомдол гаргаж, өмнөх дуудлага болон баримтаа хавсарга.',
    '4. Хүүхэд зодох, гэр бүлийн хүчирхийлэл, тусламж гуйх дуу чимээ сонсогдвол энгийн шуугиан гэж үзэлгүй 102 болон хүүхэд хамгааллын байгууллагад яаралтай мэдэгд.',
    '',
    '**Хуулийн үндэслэл**',
    referenceLines,
    '',
    '**Анхаарах эрсдэл**',
    'Өөрөө очиж маргалдах, хаалга нүдэх, заналхийлэх нь асуудлыг хүндрүүлж өөрт тань зөрчил үүсгэх эрсдэлтэй. Харин дуудлага, бичлэг, гэрч, давтамжийн тэмдэглэлтэй бол цагдаа болон холбогдох байгууллага шалгах үндэслэл илүү тодорхой болно.',
    '',
    '**Практик зөвлөгөө**',
    '- Дуу чимээ эхэлсэн, дууссан цагийг тэмдэглэж, 2-3 удаагийн давтамжтай нотолгоо үүсгэ.',
    '- 102-т өгсөн дуудлагын огноо, цаг, боломжтой бол дуудлагын дугаарыг хадгал.',
    '- Хүчирхийллийн шинжтэй орилох, хүүхэд уйлах, тусламж гуйх дуу сонсогдвол шууд яаралтай дуудлага өг.',
  ].join('\n');

  return {
    answer,
    confidence: refs.length > 0 ? 0.74 : 0.62,
    promptTokens: 0,
    completionTokens: 0,
    mode: refs.length > 0 ? 'context' : 'fallback-general',
    suggestedQuestions: [
      '102 руу дуу чимээний талаар яг юу гэж хэлэх вэ?',
      'СӨХ-д өгөх гомдлын загвар бичиж өгөх үү?',
      'Хүүхэд уйлж, хүчирхийлэл байж болзошгүй үед яаралтай ямар байгууллагад мэдэгдэх вэ?',
    ],
  };
}

function buildLaborDocumentChecklistFallback(): GenerationResult {
  const answer = [
    'Ажлаас үндэслэлгүй халсан эсэхийг маргахдаа хамгийн түрүүнд ажлаас халсан шийдвэр, хөдөлмөрийн гэрээ, цалин болон ажилласан хугацааг нотлох баримтаа бүрдүүлнэ.',
    '',
    '**Яг одоо бүрдүүлэх баримт**',
    '- Ажлаас халсан тушаал, мэдэгдэл, ажил олгогчоос тайлбар авсан эсэх (албан бичгээр).',
    '- Хөдөлмөрийн гэрээ, ажлын байрны тодорхойлолт, дотоод журам, нэмэлт гэрээнүүд.',
    '- Цалингийн баримт, цалингийн хуудас, нийгмийн даатгалын шимтгэлийн лавлагаа, цагийн бүртгэл, цалин шилжсэн банкны хуулга.',
    '- Сахилгын шийтгэлийн материал, сануулах хуудас, шалгах ажиллагааны тэмдэглэл (хэрэв бий бол).',
    '- Халагдсан шалтгаантай холбоотой имэйл, чат, мессеж, гэрчийн мэдээлэл.',
    '- Хувийн ажилгүй байсан хугацааны нотолгоо: ажил эрж тэмцсэн зар, эрүүл мэндийн магадлагаа.',
    '',
    '**Анхаарах зүйл**',
    'Ажил олгогч халсан үндэслэлээ хуульд нийцүүлж, бичгээр баримтжуулсан байх ёстой. Тушаал, мэдэгдэл, тайлбар дутуу бол маргаанд таны талд ашиглагдах боломжтой. Хөдөлмөрийн маргаанд гомдол, нэхэмжлэл гаргах хугацааг үлдсэн өдрөөр нь шалгаарай.',
    '',
    '**Практик зөвлөгөө**',
    '- Баримтуудаа огнооны дарааллаар ангилж нэг хавтаст хий.',
    '- Ажил олгогчоос тушаал, тооцооны хуудас, нийгмийн даатгалын бичилтээ бичгээр шаардаж ав.',
    '- Хариу өгөхгүй бол шаардсан огноог тэмдэглэж, дараа маргаанд нотолгоо болгон ашигла.',
  ].join('\n');

  return {
    answer,
    confidence: 0.74,
    promptTokens: 0,
    completionTokens: 0,
    mode: 'context',
    suggestedQuestions: [
      'Ажлаас халсан тушаал хууль бус эсэхийг яаж шалгах вэ?',
      'Хөдөлмөрийн маргаанд гомдол гаргах хугацаа хэд вэ?',
      'Цалин болон ажилласан хугацааг ямар баримтаар нотлох вэ?',
    ],
  };
}

function buildContractDocumentChecklistFallback(): GenerationResult {
  const answer = [
    'Гэрээний маргаан, өр төлбөр, нөхөн төлбөрийн асуудалд таны шаардлагыг нотлох гэрээ, тооцоо, төлбөрийн баримт, харилцсан мэдэгдэл нь үндсэн нотолгоо болно.',
    '',
    '**Яг одоо бүрдүүлэх баримт**',
    '- Үндсэн гэрээ, нэмэлт гэрээ, эргэн төлөлтийн хуваарь, хавсралт бүхий хуудас.',
    '- Төлбөр, шилжүүлгийн баримт, банкны хуулга, төлсөн огноо, дүн, гүйлгээний тайлбар.',
    '- Нөгөө талд өгсөн бичгийн шаардлага, мэдэгдэл, имэйл, чат, ажил гүйцэтгэсэн акт.',
    '- Гэрээ зөрчигдсөн нөхцөлийг нотлох баримт: гүйцэтгэл хоцорсон цаг хугацаа, чанарын акт, гуравдагч талын тайлан, гэрчийн мэдээлэл.',
    '- Хохирлын тооцоо: алдагдсан орлого, нэмж зарцуулсан зардал, гуравдагч талд төлсөн торгууль.',
    '- Барьцаа, баталгаа, даатгалын гэрээ (хэрэв байгаа бол).',
    '',
    '**Анхаарах зүйл**',
    'Гэрээний өргөдөл, мэдэгдлээ зөвхөн амаар биш заавал бичгээр хүргүүлж, хүлээн авсныг батлуулах нь чухал. Хугацаа хэтрүүлсэн анз, алданги, хүү тооцох нөхцлийг гэрээний заалттай нь шалгасны дараа шаардлагаа бичгээр гарга.',
    '',
    '**Практик зөвлөгөө**',
    '- Гэрээний хувь хүн бүрд нэг хувь хадгалуулсан байх ёстой; алга бол нөгөө талаас хуулбар шаардаж ав.',
    '- Хохирлын тооцоог үндсэн өр, хүү, нэмэгдсэн хүү, шүүхийн зардал гэж тус тусад нь задлан гарга.',
    '- Дамжуулсан мэдэгдлийг и-мэйл, мессеж, бичгээр зэрэг 2 сувгаар явуулж нотолгоо хадгал.',
  ].join('\n');

  return {
    answer,
    confidence: 0.72,
    promptTokens: 0,
    completionTokens: 0,
    mode: 'context',
    suggestedQuestions: [
      'Гэрээний заалт зөрчигдсөнийг ямар баримтаар хамгийн сайн нотлох вэ?',
      'Шүүхэд хандахаас өмнө бичгийн шаардлагын загвар бичиж өгөх үү?',
      'Гэрээний хүү, алданги хууль ёсны эсэхийг яаж шалгах вэ?',
    ],
  };
}

function buildTrafficDocumentChecklistFallback(): GenerationResult {
  const answer = [
    'Зам тээврийн ослын маргаан болон даатгалын нөхөн төлбөрийн асуудалд цагдаагийн тэмдэглэл, ослын схем, баримт, гэрчийн мэдээлэл нь шийдвэрлэх нотолгоо болно.',
    '',
    '**Яг одоо бүрдүүлэх баримт**',
    '- Цагдаагийн ослын бүртгэл, ослын схем, талбайн үзлэгийн акт, эрх бүхий хүний шийдвэр.',
    '- Тээврийн хэрэгслийн гэмтлийн зураг, видео, дэшкам бичлэг (4 талаас, бүх хорсон цэг тус бүрд).',
    '- Жолоочийн үнэмлэх, тээврийн хэрэгслийн гэрчилгээ, даатгалын полис, нөгөө талын ижил мэдээлэл.',
    '- Хохирлын үнэлгээ: засварын газрын акт, бэлэн эд анги, ажилчны хөдөлмөрийн зардал, зөөвөрлөлтийн төлбөр.',
    '- Хүн гэмтсэн бол эмнэлгийн магадлагаа, оношилгоо, эмчилгээний баримт, ажилгүй байсан хугацааны тайлан.',
    '- Гэрчийн нэр, утас, тайлбар, ослын газрын ойролцоох камер бичлэгийг авах хүсэлт.',
    '',
    '**Анхаарах зүйл**',
    'Даатгалын компанид мэдэгдэх хугацаа гэрээнд тусгайлан заасан байдаг (ихэвчлэн 24-72 цаг). Хугацаа хоцорвол нөхөн төлбөрөөс татгалзах үндэслэл болж болзошгүй. Хүн гэмтсэн, согтуугаар жолоодсон, ослын газраас явсан тохиолдолд зөвхөн даатгал биш зөрчил/эрүүгийн хариуцлага үүснэ.',
    '',
    '**Практик зөвлөгөө**',
    '- Ослын газрыг хөдөлгөхөөс өмнө 4 талаас зураг ав, ойр орчны камер, гэрчийг тэр дор нь бүртгэ.',
    '- Даатгалд мэдэгдсэн огноо, харилцагчийн нэр, лавлагааны дугаарыг бичгээр баримтжуул.',
    '- Засварыг эхлүүлэхээс өмнө даатгалын үнэлгээ хийлгэх, акт гаргуулах.',
  ].join('\n');

  return {
    answer,
    confidence: 0.72,
    promptTokens: 0,
    completionTokens: 0,
    mode: 'context',
    suggestedQuestions: [
      'Даатгалын компанид мэдэгдэх албан бичгийн загвар бичиж өгөх үү?',
      'Камер байхгүй бол ослыг ямар баримтаар нотлох вэ?',
      'Хохирлын үнэлгээг нэмж шалгуулах боломжтой юу?',
    ],
  };
}

function buildCrimeDocumentChecklistFallback(): GenerationResult {
  const answer = [
    'Эрүүгийн шинжтэй асуудалд (залилан, хулгай, цахим луйвар, эд хөрөнгөтэй холбоотой) цагдаад өгөх гомдолд та өөрөө нотлох баримтаа бүрэн бэлдэх хэрэгтэй.',
    '',
    '**Яг одоо бүрдүүлэх баримт**',
    '- Хохирлын тодорхой тооцоо: алдсан мөнгөн дүн, эд хөрөнгө, дансны хуулга, шилжүүлгийн баримт.',
    '- Сэжигтэн этгээдтэй харилцсан чат, мессеж, дуудлагын түүх, зар, профайл, линкийг устгахгүй screenshot хэлбэрээр.',
    '- IMEI, серийн дугаар, худалдан авалтын баримт, хайрцаг (гар утас, цахим төхөөрөмжийн хувьд).',
    '- Гэрчийн нэр, утас, тайлбар; ослын/үйлдлийн газрын камерын бичлэгийн хүсэлт.',
    '- Банкны харилцагчийн алба, оператор, үйлчилгээ үзүүлэгчид өгсөн бичгийн мэдэгдэл, хариу.',
    '- Хохирогчийн мэдүүлгийн төсөл (хэн, хэзээ, хаана, юу болсон, хэн оролцсон).',
    '',
    '**Анхаарах зүйл**',
    'Цаг хугацаа маш чухал: гүйлгээ дамжих, чат устгагдах, камерын бичлэг 24-72 цагт устах эрсдэлтэй. Цагдаад мэдэгдсэн огноо, хүлээж авсан албан тушаалтны нэр, бүртгэлийн дугаарыг заавал бичгээр ав.',
    '',
    '**Практик зөвлөгөө**',
    '- Гомдлын өргөдөлдөө хохирлын дүн, үйлдэл, нотолгоог нэг бүрчлэн бич.',
    '- Цахим баримтыг screenshot + PDF давхар хадгалж, файлын огноо цагийг хадгал.',
    '- "Мөнгөө буцааж авах" гэх дахин шилжүүлгийн саналд татгалз; шинэ хохирол үүсгэх эрсдэлтэй.',
  ].join('\n');

  return {
    answer,
    confidence: 0.72,
    promptTokens: 0,
    completionTokens: 0,
    mode: 'context',
    suggestedQuestions: [
      'Цагдаад өгөх гомдлын өргөдлийн загвар бичиж өгөх үү?',
      'Цахим баримтыг хуулийн өмнө хүчинтэй хэлбэрээр яаж хадгалах вэ?',
      'Хохирол нөхөн төлүүлэх иргэний нэхэмжлэлийг хэзээ нэмж гаргах вэ?',
    ],
  };
}

function buildFamilyDocumentChecklistFallback(): GenerationResult {
  const answer = [
    'Гэр бүлийн маргаан, хүүхдийн тэтгэлэг, асрамж, гэр бүл цуцлуулах асуудлуудад гэр бүлийн харилцааны болон орлого-эд хөрөнгийн баримт нь нотолгооны үндэс болно.',
    '',
    '**Яг одоо бүрдүүлэх баримт**',
    '- Гэр бүлийн гэрчилгээ, төрсний гэрчилгээ, хүүхдийн төрсний бүртгэл.',
    '- Орлогын баримт: цалин, татварын тооцоо, нийгмийн даатгалын лавлагаа, хувиараа ажилладаг бол санхүүгийн тайлан.',
    '- Хүүхэдтэй холбоотой зардлын баримт: цэцэрлэг, сургуулийн төлбөр, эмчилгээ, хоол хүнс, хувцас.',
    '- Орон сууцны нөхцлийн нотолгоо: гэрчилгээ, гэрээ, оршин суух хаягийн лавлагаа, тэжээгчийн харилцаа.',
    '- Гэр бүлийн харилцааны баримт: чат, имэйл, гэрчийн тайлбар, тогтоосон тохиролцоо.',
    '- Эрүүл мэндийн магадлагаа, хүчирхийллийн нотолгоо (хэрэв тэр асуудал орсон бол).',
    '',
    '**Анхаарах зүйл**',
    'Хүүхдийн эрх ашгийг хамгаалах нь шүүхийн анхаардаг гол зүйл. Хүүхдийн оршин суух газар, сурч хүмүүжих орчин, эцэг эх тус бүртэй харилцах байдлыг нотлох баримт нь шийдвэрт шууд нөлөөлнө.',
    '',
    '**Практик зөвлөгөө**',
    '- Эвлэрлийн оролдлогыг бичгээр буюу гэр бүлийн зөвлөгөө өгөх албанд бүртгүүлж нотолгоо үлдээ.',
    '- Тэтгэлгийн тооцоог сарын дундаж зардлаар хүүхэд тус бүрд нь задлан гарга.',
    '- Орлогын мэдээллийг сүүлийн 6-12 сараар тооцож, банкны хуулга хавсарга.',
  ].join('\n');

  return {
    answer,
    confidence: 0.72,
    promptTokens: 0,
    completionTokens: 0,
    mode: 'context',
    suggestedQuestions: [
      'Тэтгэлгийн дүнг яаж тооцох вэ?',
      'Хүүхдийн асрамжид шүүх ямар баримт онцолж үздэг вэ?',
      'Гэр бүл цуцлуулах өргөдөл хаашаа гаргах вэ?',
    ],
  };
}

function buildGenericDocumentChecklistFallback(): GenerationResult {
  const answer = [
    'Хууль зүйн маргаанд таны шаардлага, эрхийг нотлох баримтыг урьдчилан цэгцлэх нь шийдвэрлэх эхний алхам юм.',
    '',
    '**Яг одоо бүрдүүлэх баримт**',
    '- Холбогдох гэрээ, тушаал, акт, бичиг баримт (анхны хувь эсвэл албан бичгээр баталгаажсан хуулбар).',
    '- Мөнгөн төлбөрийн баримт: банкны хуулга, кассын баримт, шилжүүлгийн тайлан, нэхэмжлэх.',
    '- Нөгөө талтай харилцсан мэдэгдэл: имэйл, мессеж, чат, бичгийн өргөдөл болон хариу.',
    '- Гэрчийн нэр, утас, тайлбар; орчны камерын бичлэгийн хүсэлт.',
    '- Хохирлын тооцоо: бодит зардал, олох ёстой байсан орлого, төлсөн торгууль.',
    '- Хууль ёсны төлөөлөл хийх итгэмжлэл, өөрийн иргэний үнэмлэхний хуулбар.',
    '',
    '**Анхаарах зүйл**',
    'Аман тохиролцоо нь нотлоход хүндрэлтэй тул бүх шаардлага, хариуг бичгээр баримтжуулах нь чухал. Хуулийн хугацаа (гомдол, нэхэмжлэл гаргах) алдвал шаардах эрхээ алдах эрсдэлтэй.',
    '',
    '**Практик зөвлөгөө**',
    '- Баримтаа огнооны дарааллаар ангилж нэг хавтаст хий.',
    '- Шаардлагатай бол нотариатаар хуулбарыг баталгаажуулж бэлд.',
    '- Аль эрх бүхий байгууллагад хандах эсэхээ урьдчилан тодорхойлж, тэр шатанд шаардагдах нэмэлт маягтыг олж аваарай.',
  ].join('\n');

  return {
    answer,
    confidence: 0.66,
    promptTokens: 0,
    completionTokens: 0,
    mode: 'fallback-general',
    suggestedQuestions: [
      'Миний нөхцөлд хамгийн чухал нотолгоо нь юу вэ?',
      'Аль байгууллагад хамгийн түрүүнд хандах вэ?',
      'Хууль ёсны хугацаагаа яаж шалгах вэ?',
    ],
  };
}

function buildDocumentChecklistByIntent(intent: QueryIntent): GenerationResult {
  switch (intent) {
    case 'labor':
      return buildLaborDocumentChecklistFallback();
    case 'contract':
      return buildContractDocumentChecklistFallback();
    case 'traffic':
      return buildTrafficDocumentChecklistFallback();
    case 'crime':
      return buildCrimeDocumentChecklistFallback();
    case 'family':
      return buildFamilyDocumentChecklistFallback();
    default:
      return buildGenericDocumentChecklistFallback();
  }
}

/**
 * Heuristic: when the user explicitly asked "ямар баримт бүрдүүлэх вэ?" the LLM
 * is expected to produce a clear bullet-style checklist. If it returned a short
 * generic answer with few bullets and almost no mention of "баримт/нотолгоо",
 * we treat it as a weak response and swap in the deterministic checklist.
 */
function isWeakDocumentChecklistAnswer(answer: string): boolean {
  const cleaned = answer.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return true;
  }

  const wordCount = cleaned.split(' ').length;
  if (wordCount < 90) {
    return true;
  }

  const bulletCount = (answer.match(/^\s*[-*]\s+/gm) ?? []).length;
  if (bulletCount < 4) {
    return true;
  }

  const mentionsDocuments = /баримт|нотолгоо|нотлох|тушаал|гэрээ|хуудас|акт|бичиг|тооцоо/i.test(
    cleaned,
  );
  if (!mentionsDocuments) {
    return true;
  }

  return false;
}

function buildConsumerRefundFallback(query: string, chunks: ChromaQueryResult[]): GenerationResult {
  const refs = collectQaReferences(query, chunks)
    .filter((ref) =>
      /хэрэглэгч|иргэний\s+хууль|худалдах|худалдан|бараа|бүтээгдэхүүн|доголдол|чанар|буцаалт|нөхөн\s*төлбөр/i.test(
        normalizeForMatch(`${ref.summary} ${ref.citation}`),
      ),
    )
    .slice(0, 4);
  const referenceLines =
    refs.length > 0
      ? formatCompactReferenceLines(refs)
      : [
          '1. Хэрэглэгчийн эрхийг хамгаалах тухай хууль болон Иргэний хуулийн худалдах-худалдан авах гэрээний зохицуулалтаар доголдолтой бараанд засварлуулах, солих, үнийг бууруулах, буцаах, хохирол шаардах боломжийг шалгана.',
          '2. Онлайн худалдан авалтын үед захиалгын баримт, төлбөрийн баримт, хүргэлтийн мэдээлэл, дэлгүүртэй харилцсан чат, бүтээгдэхүүний зураг нь шаардлага гаргах үндсэн нотолгоо болно.',
        ].join('\n\n');

  const answer = [
    'Онлайн дэлгүүрээс авсан бүтээгдэхүүн доголдолтой ирсэн бол буцаалт, солих, засварлуулах, үнийг бууруулах эсвэл төлсөн мөнгөө буцаан авах талаар маргах боломжтой. Гол нь доголдлыг авсан даруйдаа баримтжуулж, худалдагчид бичгээр шаардлага өгөөд хариуг нь хадгалах хэрэгтэй.',
    '',
    '**Яг одоо хийх алхам**',
    '1. Захиалгын дугаар, төлбөрийн баримт, хүргэлтийн баримт, бүтээгдэхүүний сав баглаа, доголдлын зураг/видеог нэг багц болго.',
    '2. Онлайн дэлгүүрт “доголдолтой бүтээгдэхүүн ирсэн тул буцаалт/солилт/мөнгөн төлбөр буцаахыг шаардаж байна” гэж бичгээр мэдэгдээд хугацаа зааж хариу ав.',
    '3. Худалдагч буцаалт хийхгүй бол хэрэглэгчийн гомдол хүлээн авах эрх бүхий байгууллага, хэрэглэгчийн эрх хамгаалах байгууллага эсвэл шүүхэд хандахад ашиглах баримтаа хадгал.',
    '4. Бүтээгдэхүүнийг өөрөө задлан засварлах, гэмтлийг нэмэгдүүлэх үйлдэл хийхээс зайлсхий; маргаанд “хэрэглэгч өөрөө гэмтээсэн” гэж маргах эрсдэлтэй.',
    '',
    '**Хуулийн үндэслэл**',
    referenceLines,
    '',
    '**Анхаарах эрсдэл**',
    'Худалдагчтай зөвхөн утсаар ярьсан бол дараа нь нотлоход сул байдаг. Иймээс чат, имэйл, албан шаардлага, төлбөрийн баримт, хүргэлтийн огноо, доголдлын зураг зэрэг бичгээр үлдэх нотолгоог бүрдүүл. Буцаалтын хугацаа, баталгааны нөхцөл, “хүлээн авснаас хойш хэд хоногт мэдэгдэх” гэсэн дэлгүүрийн нөхцөлийг давхар шалга.',
    '',
    '**Практик зөвлөгөө**',
    '- Дэлгүүрт өгөх шаардлагадаа захиалгын дугаар, авсан огноо, доголдлын тодорхой тайлбар, шаардаж буй шийдлээ нэг мөрөөр бич.',
    '- “Солих уу, мөнгө буцаах уу, засварлуулах уу” гэдгээ тодорхой сонгож бичвэл маргаан сунжрах нь багасна.',
    '- Хэрэв дэлгүүр таныг блоклох, хариу өгөхгүй байх, баримтаа устгах шинжтэй байвал screenshot-оо шууд хадгал.',
  ].join('\n');

  return {
    answer,
    confidence: refs.length > 0 ? 0.76 : 0.66,
    promptTokens: 0,
    completionTokens: 0,
    mode: refs.length > 0 ? 'context' : 'fallback-general',
    suggestedQuestions: [
      'Доголдолтой барааг буцаах шаардлагын загвар бичиж өгөх үү?',
      'Онлайн дэлгүүр буцаалт хийхгүй бол хаана гомдол гаргах вэ?',
      'Доголдлыг нотлох ямар баримт хамгийн чухал вэ?',
    ],
  };
}

function buildLaborDismissalWageFallback(
  query: string,
  chunks: ChromaQueryResult[],
): GenerationResult {
  const dismissalFocus = /ажлаас|халагд|халуул|халсан|үндэслэлгүй/i.test(normalizeForMatch(query));
  const refs = collectQaReferences(query, chunks)
    .filter(
      (ref) =>
        /хөдөлмөр|ажлаас|халах|халагд|дуусгавар|цалин|олговор|ажил\s+олгогч|маргаан/i.test(
          normalizeForMatch(`${ref.summary} ${ref.citation}`),
        ) && !/ажил\s+үүрэг\s+гүйцэтгэхийг\s+түдгэлзүүлэх/i.test(normalizeForMatch(ref.summary)),
    )
    .slice(0, 4);
  const referenceLines =
    refs.length > 0
      ? formatCompactReferenceLines(refs)
      : [
          '1. Хөдөлмөрийн тухай хуульд хөдөлмөр эрхлэлтийн харилцаа дуусгавар болгох үндэслэл, ажлаас халсан шийдвэр гаргах журам, цалин хөлс, олговор, хөдөлмөрийн маргаан шийдвэрлэх журмыг шалгана.',
          '2. Цалин төлүүлэх шаардлага нь ажилласан хугацаа, цалингийн тооцоо, тушаал, гэрээ, цагийн бүртгэлээр нотлогдох ёстой.',
        ].join('\n\n');
  const opening = dismissalFocus
    ? 'Үндэслэлгүй ажлаас халсан гэж үзэж байгаа бол ажлаас халсан шийдвэрийг хүчингүй болгуулах, ажилд эгүүлэн тогтоолгох, ажилгүй байсан хугацааны цалин болон дутуу цалинг нэхэмжлэхээр маргах боломжтой. Таны хамгийн түрүүнд хийх зүйл бол халсан тушаал, хөдөлмөрийн гэрээ, цалингийн тооцоо, ажилласан цагийн нотолгоогоо бүрдүүлэх юм.'
    : 'Цалин хөлсөө бүрэн аваагүй, ажил олгогч төлөхөөс татгалзаж байгаа бол ажилласан хугацаа, цалингийн хэмжээ, цагийн бүртгэл, тушаал, гэрээ, банкны хуулгаар нотолж цалин төлүүлэхээр маргах боломжтой. Эхлээд ажил олгогчоос тооцоог бичгээр гаргуулж, дутуу төлбөрөө тодорхой дүнгээр шаард.';
  const actionSteps = dismissalFocus
    ? [
        '1. Ажлаас халсан тушаал, мэдэгдэл, хөдөлмөрийн гэрээ, ажлын байрны тодорхойлолт, дотоод журам, цалингийн баримтаа ав.',
        '2. Ажил олгогчоос халсан үндэслэл, тооцоо дуусгасан байдал, дутуу цалин байгаа эсэхийг бичгээр тодруул.',
        '3. Халагдсан огноо, ажилласан хугацаа, цалин хөлс, нийгмийн даатгалын бичилт, имэйл/чат/гэрчийн мэдээллээ цаг хугацааны дарааллаар эмхэл.',
        '4. Дотоод гомдол, хөдөлмөрийн маргаан шийдвэрлэх шат эсвэл шүүхэд хандах хугацаагаа алдахгүйгээр нэхэмжлэл/гомдлоо бэлд.',
      ]
    : [
        '1. Хөдөлмөрийн гэрээ, цалингийн хэмжээ, цагийн бүртгэл, ажилласан өдрийн нотолгоо, банкны хуулгаа нэг багц болго.',
        '2. Ажил олгогчоос цалингийн тооцоо, дутуу төлбөрийн шалтгаан, төлөх хугацааг бичгээр гаргуул.',
        '3. Дутуу цалин, илүү цаг, амралтын мөнгө, нэмэгдэл хөлсөө тус тусад нь тооцож шаардлагаа бичгээр өг.',
        '4. Хариу өгөхгүй эсвэл төлөхгүй бол хөдөлмөрийн маргаан шийдвэрлэх шат, шаардлагатай бол шүүхэд ханд.',
      ];

  const answer = [
    opening,
    '',
    '**Яг одоо хийх алхам**',
    ...actionSteps,
    '',
    '**Хуулийн үндэслэл**',
    referenceLines,
    '',
    '**Анхаарах эрсдэл**',
    'Хөдөлмөрийн маргаанд хугацаа маш чухал. Халсан тушаалын огноо, тушаал хүлээн авсан өдөр, цалин тооцсон эсэх, ажил олгогчийн бичгээр өгсөн үндэслэл зэрэг нь маргааны үр дүнд шууд нөлөөлнө. Аман тайлбар хангалтгүй тул бүх шаардлага, хариуг бичгээр авч хадгал.',
    '',
    '**Практик зөвлөгөө**',
    '- “Ажлаас халсан тушаалын хуулбар, цалингийн эцсийн тооцоо, нийгмийн даатгалын бичилтээ өгнө үү” гэж бичгээр шаард.',
    '- Цалин нэхэмжлэхдээ үндсэн цалин, нэмэгдэл, илүү цаг, амралтын мөнгө, ажилгүй байсан хугацааны олговор зэргийг тусад нь тооц.',
    '- Ажил олгогчтой маргалдахдаа мессеж, имэйл, тушаалын огноо, гарын үсэгтэй баримтаа устгахгүй хадгал.',
  ].join('\n');

  return {
    answer,
    confidence: refs.length > 0 ? 0.76 : 0.66,
    promptTokens: 0,
    completionTokens: 0,
    mode: refs.length > 0 ? 'context' : 'fallback-general',
    suggestedQuestions: [
      'Ажлаас халсан тушаал хууль ёсны эсэхийг яаж шалгах вэ?',
      'Ажилгүй байсан хугацааны цалинг яаж тооцож нэхэмжлэх вэ?',
      'Хөдөлмөрийн маргаанд ямар баримт хамгийн чухал вэ?',
    ],
  };
}

function collectQaReferences(query: string, chunks: ChromaQueryResult[]): QaReference[] {
  const seen = new Set<string>();
  const refs: QaReference[] = [];

  for (const chunk of chunks) {
    if (refs.length >= 4) {
      break;
    }

    const meta = chunk.metadata;
    const title = String(meta.title ?? meta.documentTitle ?? 'Хууль').trim();
    const lawId = String(meta.sourceId ?? meta.lawId ?? '').trim();
    const rawUrl = String(meta.url ?? '').trim();
    const articleNo = normalizeArticleNumber(
      extractQueryAlignedArticleNumber(query, chunk) || String(meta.articleNo ?? ''),
    );
    const articleTitle = extractChunkArticleTitle(meta, chunk.document ?? '');
    const url = lawId
      ? buildContextDeepLink(query, lawId, rawUrl, articleTitle, chunk.document ?? '', articleNo)
      : rawUrl;

    if (!url) {
      continue;
    }

    const key = `${lawId || title}:${articleNo || 'general'}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const abbrev = resolveQaLawAbbrev(title, lawId);
    const citation = articleNo ? `[${abbrev}-ийн §${articleNo}](${url})` : `[${title}](${url})`;
    const cleanArticleTitle = cleanArticleTitleForUser(articleTitle);
    const excerpt = cleanReferenceExcerptForUser(String(chunk.document ?? ''));
    const sourceLabel = articleNo ? `${title} §${articleNo}` : title;
    const summary = cleanArticleTitle
      ? `${sourceLabel} — ${cleanArticleTitle}. ${excerpt}`
      : `${sourceLabel}. ${excerpt}`;
    const shortLabel = cleanArticleTitle || firstSentenceOfExcerpt(excerpt, 120);

    refs.push({ summary, citation, shortLabel });
  }

  return refs;
}

function firstSentenceOfExcerpt(text: string, maxLen: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return '';
  }

  const match = cleaned.match(/^[^.!?…]+[.!?…]/u);
  const first = match ? match[0].trim() : cleaned;
  if (first.length <= maxLen) {
    return first;
  }

  return `${first.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

/**
 * Format a list of QaReference items as a compact bullet list of citation
 * chips with an optional short label, e.g.:
 *   - [ХТ-ийн §128](url) — Цалин хөлсний төрөл
 * Use this instead of the legacy verbose `${idx}. ${summary}\n  ${citation}`
 * pattern so scenario fallbacks stop dumping raw chunk excerpts into the
 * "Хуулийн тайлбар" section.
 */
function formatCompactReferenceLines(refs: QaReference[]): string {
  const lines = refs
    .filter((ref) => ref.citation && ref.citation.length > 0)
    .map((ref) => (ref.shortLabel ? `- ${ref.citation} — ${ref.shortLabel}` : `- ${ref.citation}`));
  return lines.join('\n');
}

function cleanArticleTitleForUser(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  if (
    !cleaned ||
    /^(?:хамаарахгүй|үйлчлэхгүй|нэгэн адил хамаарна|д заасан|д заасны дагуу|энэ хууль|хууль тогтоомж)$/iu.test(
      cleaned,
    )
  ) {
    return '';
  }

  return cleaned.length > 90 ? `${cleaned.slice(0, 87).trimEnd()}…` : cleaned;
}

function cleanReferenceExcerptForUser(text: string): string {
  let cleaned = text.replace(/\s+/g, ' ').trim();
  cleaned = cleaned
    .replace(/^Хууль:\s*[^:]{0,220}?\s+Зүйл:\s*\d+(?:\.\d+)?\s*/iu, '')
    .replace(/^\d+(?:\.\d+)?\s*(?:дүгээр|дугаар)\s+зүйл\.?\s*/iu, '')
    .replace(/^[А-ЯӨҮЁ0-9 ,/()"'“”«».-]{8,160}\s+(?=\d+(?:\.\d+)?\s|[А-ЯӨҮЁ])/u, '')
    .trim();

  if (!cleaned || /^Хууль:/iu.test(cleaned)) {
    return 'Энэ эх сурвалж тухайн асуудлын эрх, үүрэг, шаардлага гаргах үндэслэлийг тодруулахад ашиглагдана.';
  }

  return compactFallbackText(cleaned, 170);
}

function resolveQaLawAbbrev(title: string, lawId: string): string {
  const byLawId: Record<string, string> = {
    '299': 'ИХ',
    '12172': 'ЭХ',
    '12695': 'ЗТ',
    '11224': 'ЗХАБТХ',
    '101004': 'ХЭХТХ',
    '226': 'ГБТ',
    '12393': 'ГБХТТХ',
    '11223': 'ХХҮТ',
    '16230709635751': 'ХТ',
    '12694': 'ЭХШТ',
    '11220': 'ИХШТ',
  };

  if (lawId && byLawId[lawId]) {
    return byLawId[lawId];
  }

  const normalized = title.toLowerCase();
  if (normalized.includes('гэр бүлийн тухай')) return 'ГБТ';
  if (normalized.includes('хүүхдийн эрхийн тухай')) return 'ХЭТ';
  if (normalized.includes('хүүхэд хамгааллын тухай')) return 'ХХТ';
  if (normalized.includes('хүүхэд харах үйлчилгээний тухай')) return 'ХХҮТ';
  if (normalized.includes('иргэний хууль')) return 'ИХ';
  if (normalized.includes('эрүүгийн хууль')) return 'ЭХ';
  if (normalized.includes('зөрчлийн тухай')) return 'ЗТ';
  if (normalized.includes('хөдөлмөрийн тухай')) return 'ХТ';
  if (normalized.includes('иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай')) return 'ИХШТ';

  return 'Хууль';
}

function resolveTrafficScenario(query: string): TrafficScenario {
  const normalized = normalizeForMatch(query);
  const hasDui = /согтуур|согтуу|мансуур/i.test(normalized);
  const hasHitAndRun = /зугт|зугтсан|зугтчих|орхиод\s+яв|зогсолгүй/i.test(normalized);
  const hasParking = /зогсоол|паркинг/i.test(normalized);
  const hasOppositeLane = /эсрэг\s+урсгал|сөрөг\s+урсгал|урсгал\s+сөрсөн/i.test(normalized);
  const hasCollision = /осол|мөргө|мөргөлд|шүрг|шүргэ|халц|мүргэлд/i.test(normalized);

  if (hasParking && hasHitAndRun) {
    return 'parking_hit_and_run';
  }

  if (hasHitAndRun) {
    return 'hit_and_run';
  }

  if (hasOppositeLane && hasCollision) {
    return 'opposite_lane_collision';
  }

  if (hasParking && hasCollision) {
    return 'parking_collision';
  }

  if (hasDui) {
    return 'dui';
  }

  if (hasCollision) {
    return 'collision';
  }

  return 'general';
}

function isTrafficIncidentScenarioQuery(query: string): boolean {
  const scenario = resolveTrafficScenario(query);
  return scenario !== 'general' && scenario !== 'dui';
}

function isBankLoanOverdueQuery(query: string): boolean {
  const normalized = normalizeForMatch(query);
  return (
    isContractDebtBankLoanQuery(query) ||
    (isBankLoanQuery(query) &&
      /(төлөөгүй|төлөхгүй|төлж\s+чадаагүй|барагдуулаагүй|барагдуулахгүй|хугацаа\s+хэтр|хоцор|өр|алданги|нэмэгдүүлсэн\s+хүү|хариуцлага|\d+\s*сар)/i.test(
        normalized,
      ))
  );
}

function isCyberFraudQuery(query: string): boolean {
  if (isConsumerRefundQuery(query)) {
    return false;
  }

  const normalized = normalizeForMatch(query);
  return /(?=.*(?:цахим|онлайн|интернет|фишинг|facebook|фэйсбүүк|чат|линк|otp|нэг\s+удаагийн\s+код|карт|данс|гүйлгээ|шилжүүлэг|апп|мөнгө))(?=.*(?:луйвар|залил|хууран\s*мэхл|мэхэл|алда|шилжүүлсэн|авчих))/i.test(
    normalized,
  );
}

function isConsumerRefundQuery(query: string): boolean {
  const normalized = normalizeForMatch(query);
  const hasConsumerTransaction =
    /онлайн|интернет|дэлгүүр|худалдан|захиал|бүтээгдэхүүн|бараа|үйлчилгээ|хэрэглэгч/i.test(
      normalized,
    );
  const hasRefundOrDefect =
    /доголд|эвдэр|чанаргүй|таарахгүй|буцаалт|буцаах|мөнгө\s+буца|төлүүлэх|солих|баталгаа/i.test(
      normalized,
    );
  return hasConsumerTransaction && hasRefundOrDefect;
}

function isLaborDismissalOrWageQuery(query: string): boolean {
  const normalized = normalizeForMatch(query);
  return /ажлаас|халагд|халуул|халсан|ажил\s+олгогч|хөдөлмөр|цалин|олговор|үндэслэлгүй/i.test(
    normalized,
  );
}

function isPhoneTheftQuery(query: string): boolean {
  const normalized = normalizeForMatch(query);
  return (
    /(утас|утс(?:аа|ыг|анд|наас|тай)?|гар\s*утас|iphone|android|imei|сим|sim)/i.test(normalized) &&
    /(хулгай|алд|алга\s*бол|авчих|олж\s*авах|хайж\s*ол)/i.test(normalized)
  );
}

function buildQaActionSteps(intent: QueryIntent, query: string = ''): string[] {
  if (intent === 'family') {
    return [
      'Маргаан гарсан нөхцөл, огноо, харилцааны түүхийг баримтаар нэгтгэж тэмдэглэл хөтөлнө.',
      'Эвлэрүүлэн зуучлах боломжийг эхлээд ашиглаж, үр дүнгүй бол шүүхэд нэхэмжлэл гаргана.',
      'Шүүхийн шийдвэр гарсан бол шийдвэр гүйцэтгэх байгууллагаар албадан хэрэгжүүлэх хүсэлт гаргана.',
    ];
  }

  if (intent === 'labor') {
    return [
      'Ажил олгогчтой хийсэн гэрээ, тушаал, цалингийн баримтыг бүрдүүлнэ.',
      'Дотоод журмын дагуу гомдол гаргаж албан хариуг бичгээр авна.',
      'Шаардлагатай бол хөдөлмөрийн маргаан таслах комисс, шүүхэд шат дараатай хандана.',
    ];
  }

  if (intent === 'traffic') {
    switch (resolveTrafficScenario(query)) {
      case 'parking_hit_and_run':
        return [
          'Мөргөлт илэрсэн даруйд гэмтлийн ойр зураг, видео, орчны камер, цагийн тэмдэглэгээг хамт баримтжуулна.',
          'Зогсоолын хамгаалалт, СӨХ, орчны камерын хариуцагчдад яаралтай мэдэгдэж бичлэг устахаас өмнө хадгалуулна.',
          '102 болон даатгалдаа мэдэгдэж, үзлэгийн акт ба хохирлын үнэлгээг албан ёсоор хийлгэнэ.',
        ];
      case 'hit_and_run':
        return [
          'Ослын газрын зураг, видео, мөр, цаг минут, тээврийн хэрэгслийн үл мөрийг шууд баримтжуулна.',
          'Гэрч, дэшкам, орчны камерын бичлэгийг цуглуулж замын цагдаад даруй бүртгүүлнэ.',
          'Даатгалтай бол даатгагчдаа хугацаа алдалгүй мэдэгдэж, хохирлын актаа бүрэн бүрдүүлнэ.',
        ];
      case 'opposite_lane_collision':
        return [
          'Хүн гэмтсэн бол анхны тусламж, 103/102-т яаралтай мэдэгдэж ослын газрыг аюулгүй болгоно.',
          'Эсрэг урсгал орсон чиглэл, замын тэмдэг, тэмдэглэгээ, мөргөлдсөн цэг, тоормосны мөрийг зураглаж хадгална.',
          'Гэрч болон дэшкамын баримтаа цуглуулж, даатгал ба замын цагдаад албан ёсоор хүргүүлнэ.',
        ];
      case 'parking_collision':
        return [
          'Зогсоолд гарсан мөргөлтийг машины байршил, зогсолтын шугам, орчны зайн байдлаар нь баримтжуулна.',
          'Зөрчилтэй эсэхийг тогтоохын тулд камер, гэрч, хамгаалалтын тэмдэглэл зэргийг цуглуулна.',
          'Даатгалдаа мэдэгдэж, хохирлын үнэлгээ болон засварын төсвийг албан баримтаар гаргана.',
        ];
      case 'collision':
        return [
          'Осол гарсан газрын зураг, видео, тээврийн хэрэгслийн байршил ба гэмтлийг шууд баримтжуулна.',
          'Гэрч, камер болон дэшкамын бичлэгийг цуглуулж, цагдаад бүртгүүлнэ.',
          'Даатгалтай бол даатгагчдаа мэдэгдэж, хохирлын актаа бүрэн гаргана.',
        ];
      default:
        return [
          'Маргаантай холбоотой баримт, нотолгоог цаг хугацааны дарааллаар эмхэтгэнэ.',
          'Холбогдох байгууллагад бичгээр хүсэлт, гомдол гаргаж хариуг албан ёсоор авна.',
          'Эвлэрэл, захиргааны шат амжилтгүй бол шүүхийн журмаар эрхээ хамгаалуулна.',
        ];
    }
  }

  return [
    'Маргаантай холбоотой баримт, нотолгоог цаг хугацааны дарааллаар эмхэтгэнэ.',
    'Холбогдох байгууллагад бичгээр хүсэлт, гомдол гаргаж хариуг албан ёсоор авна.',
    'Эвлэрэл, захиргааны шат амжилтгүй бол шүүхийн журмаар эрхээ хамгаалуулна.',
  ];
}

function buildQaRiskGuidance(intent: QueryIntent, query: string = ''): string {
  if (intent === 'family') {
    return 'Хүүхдийн дээд ашиг сонирхол, тогтвортой орчин, сэтгэл зүйн нөхцөлд сөрөг нөлөө үүсэх эсэхийг шүүх хамгийн түрүүнд харгалздаг тул талуудын маргаан нь хүүхдийн эрх ашгийг хохироохгүй байх шаардлагатай.';
  }

  if (intent === 'traffic') {
    switch (resolveTrafficScenario(query)) {
      case 'parking_hit_and_run':
      case 'hit_and_run':
        return 'Ослын газраас зугтсан этгээдийг тодруулах баримт хурдан устах эрсдэлтэй тул ослын газар дахь камер, гэрч, ослын газрын тэмдэглэлээ хугацаа алдалгүй баталгаажуулах шаардлагатай.';
      case 'opposite_lane_collision':
        return 'Эсрэг урсгал хэн зөрчсөн, мөргөлдсөн цэг зэрэг нь камер, гэрч, замын тэмдэглэгээгээр нотлогдох учир буруутай этгээдийг тогтоох баримтаа дутууруулахгүй байх хэрэгтэй.';
      case 'parking_collision':
      case 'collision':
        return 'Ослын дараах баримтжуулалт дутуу, даатгалд мэдэгдэх хугацаа хоцорсон, цагдаад бүртгүүлээгүй тохиолдолд хохирлын тогтоолт, нөхөн төлбөр удаашрах эрсдэлтэй.';
      default:
        return 'Зөрчил дахин давтагдах, шалгалтаас зайлсхийх, шийдвэр биелүүлэхгүй байх зэрэг нөхцөл байдал нь хариуцлагын хэлбэр, хэмжээг хүндрүүлэх эрсдэлтэй.';
    }
  }

  return 'Баримт дутуу, хугацаа алдсан, эсхүл шаардлагаа тодорхой бус гаргасан тохиолдолд эрх хамгаалах ажиллагаа удаашрах, нэхэмжлэл буцаагдах, эсхүл хэсэгчлэн хэрэгсэхгүй болох эрсдэлтэй.';
}

function buildQaPracticalTips(intent: QueryIntent, query: string = ''): string[] {
  if (intent === 'family') {
    return [
      'Хүүхэдтэй уулзах, харилцах асуудлаарх бүх харилцааг бичгээр эсвэл баталгаатай сувгаар хадгал.',
      'Шүүхэд өгөх хүсэлтдээ хүүхдийн дэглэм, сургууль, эрүүл мэндтэй уялдсан тодорхой хуваарь санал болго.',
      'Шүүхийн шийдвэр биелэхгүй бол шийдвэр гүйцэтгэх шатанд шууд шилжүүлж хугацаа алдахгүй байх.',
    ];
  }

  if (intent === 'traffic') {
    switch (resolveTrafficScenario(query)) {
      case 'parking_hit_and_run':
      case 'hit_and_run':
        return [
          'Камерын бичлэгийг 24-72 цагийн дотор хадгалуулах хүсэлтээ бичгээр гарга.',
          'Засвараас өмнө гэмтлийн бүрэн зураг авч, үзлэгийн актаа гаргуулаад хадгал.',
          'Даатгал, цагдаа, хамгаалалтын тэмдэглэл гэсэн гурван сувгийн баримтаа зөрүүгүй байлгаагаар цуглуул.',
        ];
      case 'opposite_lane_collision':
        return [
          'Замын тэмдэг, тэмдэглэгээ, ослын газрын байршлыг олон өнцгөөс зурагла.',
          'Хэрэв дэшкам бий бол бичлэгийг нөөц копитой нь хадгалж, эх хувийг засварлахгүй байлга.',
          'Нөгөө талын мэдүүлэг, гэрчийн мэдүүлэг, цагдаагийн актыг нэг хавтаст багцал.',
        ];
      case 'parking_collision':
      case 'collision':
        return [
          'Ослын дараа тээврийн хэрэгслийг хөдөлгөхөөс өмнө баримтаа бүрэн цуглуул.',
          'Хохирлын үнэлгээ, засварын төсөв, фактур зэргийг анхааралтай хадгал.',
          'Хэрэв хүн гэмтсэн бол эмнэлгийн анхны үзлэг, дүгнэлтээ шууд ав.',
        ];
      default:
        return [
          'Гол баримтуудаа эх хувиар нь хадгалж, хуулбарыг хавсарган багцлах.',
          'Албан харилцаанд огноо, шаардлага, хариу өгөх хугацааг тодорхой бичих.',
          'Шаардлагатай үед мэргэшсэн хуульчаас урьдчилан зөвлөгөө авч эрсдэлээ бууруулах.',
        ];
    }
  }

  return [
    'Гол баримтуудаа эх хувиар нь хадгалж, хуулбарыг хавсарган багцлах.',
    'Албан харилцаанд огноо, шаардлага, хариу өгөх хугацааг тодорхой бичих.',
    'Шаардлагатай үед мэргэшсэн хуульчаас урьдчилан зөвлөгөө авч эрсдэлээ бууруулах.',
  ];
}

function resolveIntent(query: string, history: ChatMessage[]): QueryIntent {
  const direct = classifyLegalIntent(query);
  if (direct !== 'unknown') {
    return direct;
  }

  void history;
  return 'unknown';
}

function buildWeakContextClarificationResult(
  mode: QueryMode,
  intent: QueryIntent,
  query: string,
): GenerationResult {
  if (intent === 'unknown') {
    return {
      answer:
        'Таны асуултад зөв хууль, зүйл заалт оноохын тулд нөхцөл байдал хангалттай тодорхойгүй байна. Юу болсон, хэн оролцсон, ямар гэрээ/баримт байгаа, одоо ямар үр дүн хүсэж байгаагаа нэг өгүүлбэрээр нэмж бичвэл би илүү оновчтой хуулийн үндэслэлээр хариулна.',
      confidence: 0.28,
      promptTokens: 0,
      completionTokens: 0,
      mode: 'fallback-general',
      suggestedQuestions: [
        'Ямар үйл явдал болсон, огноо нь хэзээ вэ?',
        'Гэрээ, акт, төлбөрийн баримт, мэдэгдэл байгаа юу?',
        'Та торгууль, хариуцлага, нөхөн төлбөр эсвэл шүүхэд хандах дарааллын аль алийг мэдэхийг хүсэж байна вэ?',
      ],
    };
  }

  const missingFacts = buildMissingFactsForIntent(intent, query);
  const suggestedQuestions = buildClarifyingSuggestedQuestions(intent, query);
  const modeHint =
    mode === 'article'
      ? 'Яг аль хуулийн хэддүгээр зүйл, заалтыг тайлбарлуулах гэж байгаагаа бичвэл тухайн заалт руу чиглүүлж өгнө.'
      : mode === 'document'
        ? 'Яг ямар хуулийг бүтнээр нь эсвэл ямар бүлгийг тайлбарлуулах гэж байгаагаа бичвэл эх сурвалжийг зөв онооно.'
        : 'Эдгээр мэдээлэл тодорхой болсны дараа би зөв хууль, зүйл заалтыг эх сурвалжтай нь тулгаж тайлбарлана.';

  return {
    answer: [
      'Илүү зөв хариулахын тулд хэдэн мэдээлэл дутуу байна.',
      'Одоогийн асуултаар салбар нь ерөнхийдөө танигдаж байгаа боловч шууд тодорхой зүйл, заалт хэлэхэд эх сурвалж хангалттай баттай биш байна. Эх сурвалжийг баталгаатай онохын тулд эхлээд дараах мэдээллийг тодруулъя.',
      '',
      'Яг юу нэмж бичих вэ',
      ...missingFacts.map((fact, index) => `${index + 1}. ${fact}`),
      '',
      'Дараа нь би ингэж хариулна',
      '1. Таны нөхцөлд хамгийн ойр 2-5 хууль, зүйл заалтыг сонгоно.',
      '2. Заалт бүрийг таны бодит нөхцөлтэй холбож, хариуцлага болон эрсдэлийг тайлбарлана.',
      '3. Яг одоо хийх алхам, бүрдүүлэх баримт, хандах байгууллагыг товч жагсаана.',
      '',
      modeHint,
    ].join('\n'),
    confidence: 0.34,
    promptTokens: 0,
    completionTokens: 0,
    mode: 'fallback-general',
    suggestedQuestions,
  };
}

function buildMissingFactsForIntent(intent: QueryIntent, query: string): string[] {
  switch (intent) {
    case 'contract':
      if (/зээл|банк/i.test(query)) {
        return [
          'Зээл банкны зээл үү, хувь хүн хоорондын зээл үү гэдгийг тодруулна.',
          'Зээлийн гэрээнд хүү, нэмэгдүүлсэн хүү, алданги, барьцаа, хугацаанаас өмнө шаардах нөхцөл хэрхэн бичигдсэнийг дурдана.',
          'Хэдэн сар хоцорсон, банк бичгээр мэдэгдэл өгсөн эсэх, шүүхэд өгсөн эсэхийг бичнэ.',
          'Барьцаа хөрөнгө байгаа эсэх, банк барьцаа хэрэгжүүлэх талаар мэдэгдсэн эсэхийг нэмнэ.',
        ];
      }

      if (/даатгал|нөхөн\s*төлбөр/i.test(query)) {
        return [
          'Даатгалын төрөл, гэрээний дугаар, нөхөн төлбөрөөс татгалзсан үндэслэлийг бичнэ.',
          'Даатгалын тохиолдлыг хэдийд мэдэгдсэн, ямар баримт өгсөнөө жагсаана.',
          'Даатгал бичгээр татгалзсан уу, эсвэл зөвхөн амаар тайлбарласан уу гэдгийг тодруулна.',
          'Хохирлын үнэлгээ, акт, зураг, гэрч, цагдаагийн бүртгэл байгаа эсэхийг нэмнэ.',
        ];
      }

      return [
        'Гэрээ бичгээр байгуулсан эсэх, гол нөхцөл нь юу байсан гэдгийг бичнэ.',
        'Нөгөө тал яг ямар үүргээ биелүүлээгүй, хугацаа нь хэзээ дууссан гэдгийг тодруулна.',
        'Төлбөр, алданги, хохирлын хэмжээ болон үүнийг нотлох баримтаа дурдана.',
        'Өмнө нь бичгээр шаардлага, мэдэгдэл хүргүүлсэн эсэхийг нэмнэ.',
      ];
    case 'traffic':
      return [
        'Осол гарсан эсэх, хүн гэмтсэн эсэх, зөвхөн эд хөрөнгийн хохирол уу гэдгийг бичнэ.',
        'Согтууруулах ундаа хэрэглэсэн эсэх, ослын газраас явсан эсэх, цагдаа дуудсан эсэхийг тодруулна.',
        'Даатгалд мэдэгдсэн хугацаа, акт, зураг, камер, гэрч байгаа эсэхийг нэмнэ.',
        'Танд торгууль, ял, хохирол нөхөн төлөх эсвэл даатгалын асуудлын аль нь гол вэ гэдгийг бичнэ.',
      ];
    case 'crime':
      return [
        'Юу болсон, хохирлын хэмжээ хэд, хэзээ болсон гэдгийг тодорхой бичнэ.',
        'Цагдаад гомдол гаргасан эсэх, хэрэг бүртгэл/мөрдөн шалгах ажиллагаа эхэлсэн эсэхийг дурдана.',
        'Чат, гүйлгээ, зураг, камер, гэрч зэрэг нотлох баримт байгаа эсэхийг нэмнэ.',
        'Та одоо гомдол гаргах, хохирол нөхүүлэх, эсвэл хариуцлага мэдэхийн аль нь хэрэгтэйг бичнэ.',
      ];
    case 'labor':
      return [
        'Ажлаас халсан тушаал, хөдөлмөрийн гэрээ, ажлын байрны тодорхойлолт байгаа эсэхийг бичнэ.',
        'Халагдсан огноо, үндэслэл, ажил олгогчийн бичгээр өгсөн тайлбарыг дурдана.',
        'Цалин, ээлжийн амралт, нөхөн төлбөр, сахилгын шийтгэлтэй холбоотой эсэхийг тодруулна.',
        'Дотоод гомдол, хөдөлмөрийн маргаан шийдвэрлэх шатанд хандсан эсэхийг нэмнэ.',
      ];
    case 'family':
      return [
        'Гэрлэлт, салалт, хүүхдийн асрамж, тэтгэлэг эсвэл уулзуулах эрхийн аль асуудал болохыг бичнэ.',
        'Хүүхдийн нас, одоо хэнтэй амьдарч байгаа, өмнө нь шүүхийн шийдвэр гарсан эсэхийг тодруулна.',
        'Нөгөө тал ямар үүргээ биелүүлэхгүй байгаа, ямар баримт байгаа эсэхийг нэмнэ.',
        'Та шүүхэд хандах, эвлэрэх, эсвэл шийдвэр гүйцэтгүүлэхийн аль шатанд байгаагаа бичнэ.',
      ];
    case 'tax':
      return [
        'Ямар татвар, аль хугацааны тайлан/төлбөр болохыг тодруулна.',
        'Татварын байгууллагаас акт, мэдэгдэл, торгууль, алданги тооцсон эсэхийг бичнэ.',
        'Төлөөгүй дүн, хугацаа, тайлан өгсөн эсэхээ нэмнэ.',
        'Та маргах уу, хэсэгчлэн төлөх үү, эсвэл хариуцлагаа мэдэх үү гэдгээ бичнэ.',
      ];
    case 'socialInsurance':
      return [
        'Нийгмийн даатгалын шимтгэлийг аль хугацаанд төлөөгүйг бичнэ.',
        'Ажил олгогчтой хөдөлмөрийн гэрээ байсан эсэх, цалин бодогдсон баримт байгаа эсэхийг дурдана.',
        'e-mongolia эсвэл НД-ын лавлагаанд ямар төлөвтэй гарч байгааг нэмнэ.',
        'Та нөхөн төлүүлэх, гомдол гаргах, эсвэл тэтгэвэр/тэтгэмжид нөлөөлөх эсэхийг мэдэх үү гэдгээ бичнэ.',
      ];
    case 'election':
      return [
        'Ямар сонгууль, ямар эрх буюу бүртгэлийн асуудал болохыг тодруулна.',
        'Сонгогч, нэр дэвшигч эсвэл ажиглагчийн аль статустай холбоотойг бичнэ.',
        'Сонгуулийн байгууллагаас бичгээр татгалзсан эсэхийг нэмнэ.',
      ];
    default:
      return [
        'Үйл явдлын огноо, оролцогч талууд, баримтын төрлөө бичнэ.',
        'Ямар байгууллагад хандсан, бичгээр хариу авсан эсэхийг тодруулна.',
        'Та ямар үр дүн хүсэж байгаагаа нэмнэ.',
      ];
  }
}

function buildClarifyingSuggestedQuestions(intent: QueryIntent, query: string): string[] {
  switch (intent) {
    case 'contract':
      if (/зээл|банк/i.test(query)) {
        return [
          'Зээлийн гэрээнд нэмэгдүүлсэн хүү, алданги, барьцааны нөхцөл хэрхэн бичигдсэн бэ?',
          'Банк хугацаа хэтэрсэн талаар бичгээр мэдэгдэл өгсөн үү?',
          'Барьцаа хөрөнгө байгаа бол банк хэрэгжүүлэхээр мэдэгдсэн үү?',
        ];
      }

      return [
        'Гэрээ бичгээр байгуулсан уу, гол нөхцөл нь юу байсан бэ?',
        'Нөгөө тал ямар үүргээ хэдий хугацаанд биелүүлээгүй вэ?',
        'Бичгээр шаардлага хүргүүлсэн үү?',
      ];
    case 'traffic':
      return [
        'Осолд хүн гэмтсэн үү эсвэл зөвхөн эд хөрөнгийн хохирол уу?',
        'Цагдаа дуудсан, ослын акт гаргуулсан уу?',
        'Даатгалд хэдийд мэдэгдсэн бэ?',
      ];
    case 'crime':
      return [
        'Цагдаад гомдол гаргасан уу?',
        'Хохирлын хэмжээ хэд вэ, ямар нотлох баримт байна вэ?',
        'Хохирол нөхүүлэх үү, эсвэл хариуцлага мэдэх үү?',
      ];
    case 'labor':
      return [
        'Ажлаас халсан тушаалын үндэслэл юу гэж бичсэн бэ?',
        'Хөдөлмөрийн гэрээ, цалингийн баримт байгаа юу?',
        'Гомдол гаргах хугацаа өнгөрсөн эсэхийг шалгасан уу?',
      ];
    case 'family':
      return [
        'Хүүхдийн нас хэд вэ, одоо хэнтэй амьдарч байна вэ?',
        'Өмнө нь шүүхийн шийдвэр гарсан уу?',
        'Тэтгэлэг, асрамж, уулзуулах эрхийн аль асуудал гол вэ?',
      ];
    default:
      return [
        'Яг юу болсон талаар 2-3 өгүүлбэрээр бичнэ үү?',
        'Ямар баримт байгаа вэ?',
        'Та ямар үр дүн хүсэж байна вэ?',
      ];
  }
}

function buildArticleModeFallback(intent: QueryIntent): { answer: string; confidence: number } {
  const lawHint = getIntentLawHint(intent);
  if (!lawHint) {
    return { answer: NO_INFO_RESPONSE, confidence: 0 };
  }

  const explanation =
    intent === 'election'
      ? 'Сонгогчийн насны доод босго нь ерөнхийдөө 18 нас байдаг. Гэхдээ контекстэд тухайн зүйл/заалт баталгаатай илрээгүй тул зүйл, заалтын дугаарыг шууд дурдаагүй.'
      : intent === 'traffic'
        ? 'Тээврийн хэрэгслийг согтуугаар жолоодохтой холбоотой хариуцлага нь Зөрчлийн тухай болон Эрүүгийн хуульд заасан нөхцөлөөс хамаарч ялгаатай. Контекстэд баталгаатай зүйл илрээгүй тул дугаар заалт дурдаагүй.'
        : 'Тодорхой зүйл/заалтын дугаар асуувал яг тухайн заалтыг дэлгэрэнгүй тайлбарлаж өгнө.';

  const answer = [
    `Хуулийн нэр: ${lawHint}`,
    'Зүйл, заалт: Контекстэд баталгаатай зүйл илрээгүй.',
    `Тайлбар: ${explanation}`,
  ].join('\n');

  return { answer, confidence: 0.44 };
}

function buildDocumentModeFallback(intent: QueryIntent): { answer: string; confidence: number } {
  const lawHint = getIntentLawHint(intent);
  if (!lawHint) {
    return { answer: NO_INFO_RESPONSE, confidence: 0 };
  }

  let scope = 'Энэ салбарын эрх зүйн үндсэн харилцааг зохицуулна.';
  let sections: string[] = ['Контекст сул тул бүлгийн нарийвчилсан жагсаалт өгөөгүй.'];

  switch (intent) {
    case 'family':
      scope =
        'Гэрлэлт, гэрлэлт цуцлалт, эцэг эх ба хүүхдийн эрх үүрэг, асран хамгаалалт, тэтгэлэг зэрэг гэр бүлийн суурь харилцааг зохицуулдаг.';
      sections = [
        'Гэрлэлт байгуулах, дуусгавар болгох үндэслэл ба журам.',
        'Эцэг эх, хүүхдийн эрх үүрэг, хүүхдийн эрх ашгийг хамгаалах зарчим.',
        'Тэтгэлэг, асран хамгаалалт, харгалзан дэмжих үүргийн зохицуулалт.',
      ];
      break;
    case 'contract':
      scope =
        'Гэрээ байгуулах, өөрчлөх, цуцлах, үүргийн биелэлт, хариуцлага, хохирол нөхөн төлүүлэх зэрэг иргэний эрх зүйн гэрээний харилцааг зохицуулдаг.';
      sections = [
        'Гэрээний хүчин төгөлдөр байдал, хэлбэр ба гол нөхцөлүүд.',
        'Үүргийн биелэлт, хугацаа хэтрэлт, алданги, хохирлын нөхөн төлбөр.',
        'Эд хөрөнгө худалдах-худалдан авах, өмчлөх эрх шилжүүлэхтэй холбоотой шаардлага.',
      ];
      break;
    case 'traffic':
      scope =
        'Замын хөдөлгөөний аюулгүй байдлыг хангах, жолоочийн үүрэг, согтуугаар жолоодохтой холбоотой зөрчил болон хариуцлагын суурь зохицуулалтыг тогтоодог.';
      sections = [
        'Жолооч, замын хөдөлгөөнд оролцогчийн үндсэн эрх үүрэг.',
        'Согтуугаар жолоодох үеийн шалгалт, зөрчил тогтоох журам.',
        'Торгууль, жолоодох эрх хасах, эрүүгийн хариуцлагын уялдаа.',
      ];
      break;
    case 'election':
      scope =
        'Сонгох, сонгогдох эрхийн үндэс, сонгогчийн насны босго, санал өгөх журмын үндсэн хүрээг тодорхойлдог.';
      sections = [
        'Сонгогчийн эрх, насны доод босго (нийтлэг босго: 18 нас).',
        'Сонгуулийн байгууллага, санал авах, бүртгэлтэй холбоотой журам.',
        'Сонгуулийн төрөл тус бүрийн (УИХ, орон нутаг) тусгай шаардлагын ялгаа.',
      ];
      break;
    case 'crime':
      scope =
        'Гэмт хэргийн ангилал, ялын төрөл, эрүүгийн хариуцлагын үндэслэл, эрүүгийн эрх зүйн ерөнхий зарчмыг зохицуулдаг.';
      sections = [
        'Гэмт хэргийн бүрэлдэхүүн, гэм буруугийн хэлбэр.',
        'Ялын төрөл, хэмжээ тогтоох зарчим.',
        'Хохирол барагдуулах болон эрүүгийн хэрэг хянан шийдвэрлэхтэй холбоотой суурь ойлголтууд.',
      ];
      break;
    case 'tax':
      scope =
        'Татвар ногдуулах, тайлагнах, төлөх үүрэг, зөрчлийн хариуцлага болон татварын хяналтын харилцааг зохицуулдаг.';
      sections = [
        'Татвар төлөгчийн эрх үүрэг ба тайлагналын шаардлага.',
        'Татварын хугацаа хэтрэлт, алданги, торгууль тооцох үндэслэл.',
        'Татварын маргаан шийдвэрлэх ба гомдол гаргах журам.',
      ];
      break;
    case 'labor':
      scope =
        'Ажилтан, ажил олгогчийн эрх үүрэг, хөдөлмөрийн гэрээ, ажлын цаг, цалин хөлс, хөдөлмөрийн маргааны харилцааг зохицуулдаг.';
      sections = [
        'Хөдөлмөрийн гэрээ байгуулах, өөрчлөх, дуусгавар болгох үндэслэл.',
        'Цалин, амралт, сахилгын шийтгэл, хөдөлмөрийн нөхцөл.',
        'Хөдөлмөрийн маргаан шийдвэрлэх шатлал, эрх бүхий байгууллага.',
      ];
      break;
    case 'socialInsurance':
      scope =
        'Нийгмийн даатгалын шимтгэл, даатгуулагчийн эрх, ажил олгогчийн үүрэг, тэтгэвэр тэтгэмжийн суурь зохицуулалтыг тогтоодог.';
      sections = [
        'Шимтгэл ногдуулах, төлөх хугацаа, бүртгэлийн шаардлага.',
        'Даатгуулагчийн эрх, тэтгэвэр тэтгэмж авах нөхцөл.',
        'Шимтгэл төлөөгүйтэй холбоотой хариуцлага, маргаан шийдвэрлэлт.',
      ];
      break;
    default:
      break;
  }

  const answer = [
    `Хуулийн нэр: ${lawHint}`,
    `Юу зохицуулдаг: ${scope}`,
    'Гол бүлгүүд / заалтууд:',
    ...sections.map((section) => `- ${section}`),
    'Эхний зүйл: Контекст сул тул тодорхой зүйл, заалтын дугаар баталгаажуулаагүй.',
  ].join('\n');

  return { answer, confidence: 0.44 };
}

const retainedWeakContextFallbackBuilders = {
  article: buildArticleModeFallback,
  document: buildDocumentModeFallback,
};
void retainedWeakContextFallbackBuilders;

function buildModeFallbackFromContext(
  mode: QueryMode,
  query: string,
  chunks: ChromaQueryResult[],
  intentLawHint: string,
  allowedArticles: string[],
): {
  answer: string;
  confidence: number;
} {
  if (mode === 'qa') {
    const fallbackIntent = classifyLegalIntent(query);
    return buildDetailedQaFallbackFromContext(
      query,
      chunks,
      fallbackIntent !== 'unknown' ? fallbackIntent : inferIntentFromChunks(chunks),
      allowedArticles,
    );
  }

  if (chunks.length === 0) {
    return { answer: NO_INFO_RESPONSE, confidence: 0 };
  }

  const topChunk = chunks[0];
  const topScore = Number(topChunk?.score ?? 0);
  const confidence = Math.round(Math.max(0.4, Math.min(0.92, topScore)) * 100) / 100;
  const lawTitle =
    intentLawHint ||
    String(topChunk.metadata.title ?? topChunk.metadata.documentTitle ?? 'Хууль').trim();

  if (mode === 'article') {
    const articleLine =
      allowedArticles.length > 0
        ? allowedArticles.map((article) => `${article} дугаар зүйл`).join(', ')
        : 'Контекстэд баталгаатай зүйл илрээгүй.';
    const explanation = compactFallbackText(String(topChunk.document ?? ''), 420);

    return {
      answer: [
        `Хуулийн нэр: ${lawTitle}`,
        `Зүйл, заалт: ${articleLine}`,
        `Тайлбар: ${explanation}`,
      ].join('\n'),
      confidence,
    };
  }

  const sections = extractDocumentSectionHints(String(topChunk.document ?? ''));
  const sectionLine =
    sections.length > 0
      ? sections.map((section) => `- ${section}`).join('\n')
      : `- ${compactFallbackText(String(topChunk.document ?? ''), 220)}`;
  const firstArticleLine =
    allowedArticles.length > 0 ? `Эхний зүйл: ${allowedArticles[0]} дугаар зүйл` : '';

  return {
    answer: [
      `Хуулийн нэр: ${lawTitle}`,
      'Юу зохицуулдаг: Доорх контекстоос үндсэн зохицуулалтын хүрээг нэгтгэв.',
      'Гол бүлгүүд / заалтууд:',
      sectionLine,
      ...(firstArticleLine ? [firstArticleLine] : []),
    ].join('\n'),
    confidence,
  };
}

function extractDocumentSectionHints(text: string): string[] {
  if (!text) {
    return [];
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const hints = new Set<string>();
  for (const line of lines) {
    if (/^(БҮЛЭГ|АНГИ|ХЭСЭГ)\b/i.test(line)) {
      hints.add(line);
    }

    if (/^\d+(?:\.\d+)*\s*(?:дүгээр|дугаар)\s+зүйл/i.test(line)) {
      hints.add(line);
    }

    if (hints.size >= 4) {
      break;
    }
  }

  return Array.from(hints);
}

/**
 * Build the context block from retrieved chunks for the prompt.
 * Labels each chunk with law title, article number, and URL so LLM can cite correctly.
 */
const CONTEXT_DEEP_LINK_STOP_TERMS = new Set([
  'тухай',
  'хууль',
  'хуулийн',
  'эрх',
  'улсын',
  'ерөнхий',
  'нийтлэг',
  'үндэслэл',
  'зүйл',
  'заалт',
  'хэсэг',
  'болон',
  'журам',
]);

function extractChunkArticleTitle(meta: Record<string, unknown>, document: string): string {
  const fromMeta = String(meta.articleTitle ?? '').trim();
  if (fromMeta) {
    return fromMeta;
  }

  const match = document.match(/(\d+(?:\.\d+)*)\s*(?:дүгээр|дугаар)\s+зүйл[.:]*\s*([^\n]{0,80})/i);
  return (match?.[2] ?? '').trim().replace(/^[.\s]+/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildContextArticleSword(articleNo: string, document: string): string {
  const normalizedArticle = normalizeArticleNumber(articleNo);
  if (!normalizedArticle) {
    return '';
  }

  const escapedArticle = escapeRegExp(normalizedArticle);
  const headingMatch = document.match(
    new RegExp(`(?:^|\\s)(${escapedArticle}\\s*(?:дүгээр|дугаар)\\s+зүйл)`, 'i'),
  );
  if (headingMatch?.[1]) {
    return headingMatch[1].replace(/\s+/g, ' ').trim();
  }

  return normalizedArticle;
}

function pickContextDeepLinkKeyword(
  query: string,
  articleTitle: string,
  document: string,
  articleNo: string,
): string {
  const articleSword = buildContextArticleSword(articleNo, document);
  if (articleSword) {
    return articleSword;
  }

  const titleCorpus = normalizeForMatch(articleTitle);
  const textCorpus = normalizeForMatch(document.slice(0, 1600));
  const querySignals = extractSignalTerms(query);

  for (const term of querySignals) {
    if (titleCorpus.includes(term) || textCorpus.includes(term)) {
      return term;
    }
  }

  const titleTerms = titleCorpus
    .split(' ')
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !CONTEXT_DEEP_LINK_STOP_TERMS.has(term));

  if (titleTerms.length > 0) {
    return titleTerms[0];
  }

  return articleNo ? `${articleNo} зүйл` : '';
}

function buildContextDeepLink(
  query: string,
  lawId: string,
  rawUrl: string,
  articleTitle: string,
  document: string,
  articleNo: string,
): string {
  if (!lawId) {
    return rawUrl;
  }

  const swordKeyword = pickContextDeepLinkKeyword(query, articleTitle, document, articleNo);
  if (!swordKeyword) {
    return rawUrl || `https://legalinfo.mn/mn/detail?lawId=${lawId}`;
  }

  const baseUrl =
    rawUrl && rawUrl.includes('/detail') ? rawUrl.split('?')[0] : 'https://legalinfo.mn/mn/detail';
  return `${baseUrl}?lawId=${lawId}&sword=${encodeURIComponent(swordKeyword)}`;
}

function buildContextReferenceGuide(query: string, chunks: ChromaQueryResult[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const chunk of chunks) {
    if (lines.length >= 10) {
      break;
    }

    const meta = chunk.metadata;
    const title = String(meta.title ?? meta.documentTitle ?? 'Unknown');
    const lawId = String(meta.sourceId ?? meta.lawId ?? '');
    const url = String(meta.url ?? '');
    const alignedArticle = extractQueryAlignedArticleNumber(query, chunk);
    const effectiveArticle = alignedArticle || String(meta.articleNo ?? '').trim();
    const articleTitle = extractChunkArticleTitle(meta, chunk.document ?? '');
    const key = `${lawId || title}:${effectiveArticle || articleTitle || 'general'}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const deepLink = lawId
      ? buildContextDeepLink(
          query,
          lawId,
          url,
          articleTitle,
          chunk.document ?? '',
          effectiveArticle,
        )
      : url;
    const label = effectiveArticle
      ? `${title} §${effectiveArticle}${articleTitle ? `: ${articleTitle}` : ''}`
      : `${title}${articleTitle ? `: ${articleTitle}` : ''}`;

    lines.push(`${lines.length + 1}. ${label}${deepLink ? `\n   ${deepLink}` : ''}`);
  }

  return lines.length > 0 ? lines.join('\n') : 'Баталгаатай лавлах заалт илрээгүй.';
}

function buildContextBlock(
  query: string,
  chunks: ChromaQueryResult[],
  relatedCases: RelatedCase[] = [],
): string {
  if (chunks.length === 0) {
    return '(Контекст олдсонгүй / No context found)';
  }

  const requestedArticle = extractRequestedArticleNumber(query);

  const legalContext = chunks
    .map((chunk, i) => {
      const meta = chunk.metadata;
      const title = String(meta.title ?? meta.documentTitle ?? 'Unknown');
      const lawId = String(meta.sourceId ?? meta.lawId ?? '');
      const url = String(meta.url ?? '');

      const alignedArticle = extractQueryAlignedArticleNumber(query, chunk);
      const articleNo =
        requestedArticle && alignedArticle !== requestedArticle ? '' : alignedArticle;

      const metaArticleNo = String(meta.articleNo ?? '').trim();
      const effectiveArticle = articleNo || metaArticleNo;
      const articleTitle = extractChunkArticleTitle(meta, chunk.document ?? '');

      let header = `[Эх сурвалж ${i + 1}] ${title}`;
      if (effectiveArticle) {
        header += ` — ${effectiveArticle}-р зүйл`;
        if (articleTitle) {
          header += `: ${articleTitle}`;
        }
      }
      if (lawId) {
        const deepLink = buildContextDeepLink(
          query,
          lawId,
          url,
          articleTitle,
          chunk.document ?? '',
          effectiveArticle,
        );
        header += `\n🔗 ${deepLink}`;
      } else if (url) {
        header += `\n🔗 ${url}`;
      }

      const cleanBody = cleanChunkDocumentForPrompt(String(chunk.document ?? ''));
      return `${header}\n${cleanBody}`;
    })
    .join('\n\n---\n\n');

  if (relatedCases.length === 0) {
    return legalContext;
  }

  return `${legalContext}\n\n---\n\nÐ¨Ò®Ò®Ð¥Ð˜Ð™Ð ÐŸÐ ÐÐšÐ¢Ð˜ÐšÐ˜Ð™Ð Ð›ÐÐ’Ð›ÐÐ“ÐÐ:\n${buildCasePracticeGuide(relatedCases)}\n\n${buildCasePracticeBlock(relatedCases)}`;
}

function buildCasePracticeGuide(relatedCases: RelatedCase[]): string {
  if (relatedCases.length === 0) {
    return 'Ð¢Ó©ÑÑ‚ÑÐ¹ ÑˆÒ¯Ò¯Ñ…Ð¸Ð¹Ð½ Ñ…ÑÑ€Ð³Ð¸Ð¹Ð½ Ð»Ð°Ð²Ð»Ð°Ñ… Ó©Ð³Ó©Ð³Ð´Ó©Ð» Ð¾Ð»Ð´ÑÐ¾Ð½Ð³Ò¯Ð¹.';
  }

  return relatedCases
    .slice(0, 5)
    .map((caseItem, index) => {
      const meta = [
        caseItem.caseNumber ? `â„–${caseItem.caseNumber}` : '',
        caseItem.court,
        caseItem.decisionType,
      ]
        .filter(Boolean)
        .join(' | ');
      const urlLine = caseItem.url ? `\n   ${caseItem.url}` : '';
      return `${index + 1}. ${caseItem.title}${meta ? `\n   ${meta}` : ''}${urlLine}`;
    })
    .join('\n');
}

function buildCasePracticeBlock(relatedCases: RelatedCase[]): string {
  if (relatedCases.length === 0) {
    return '(Ð¢Ó©ÑÑ‚ÑÐ¹ ÑˆÒ¯Ò¯Ñ…Ð¸Ð¹Ð½ Ð¿Ñ€Ð°ÐºÑ‚Ð¸Ðº Ð¾Ð»Ð´ÑÐ¾Ð½Ð³Ò¯Ð¹)';
  }

  return relatedCases
    .slice(0, 5)
    .map((caseItem, index) => {
      const headerParts = [
        caseItem.title,
        caseItem.caseNumber ? `â„–${caseItem.caseNumber}` : '',
        caseItem.court,
        caseItem.decisionType,
      ]
        .filter(Boolean)
        .join(' | ');
      const summary = compactPromptText(caseItem.summary ?? '', 420);
      const urlLine = caseItem.url ? `\nÐ¥Ð¾Ð»Ð±Ð¾Ð¾Ñ: ${caseItem.url}` : '';
      return `[ÐšÐµÐ¹Ñ ${index + 1}] ${headerParts}${summary ? `\n${summary}` : ''}${urlLine}`;
    })
    .join('\n\n---\n\n');
}

function compactPromptText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3).trimEnd()}...`;
}

/**
 * Extract SUGGESTED_QUESTIONS block from LLM response.
 * Returns the text without the block and the parsed questions array.
 */
function parseSuggestedQuestions(text: string): { text: string; questions: string[] } {
  const sqIndex = text.indexOf('SUGGESTED_QUESTIONS:');
  if (sqIndex === -1) {
    return { text, questions: [] };
  }

  const before = text
    .slice(0, sqIndex)
    .replace(/---\s*$/, '')
    .trimEnd();
  const sqBlock = text.slice(sqIndex);

  const questions: string[] = [];
  for (const line of sqBlock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      const q = trimmed.slice(2).replace(/^\[/, '').replace(/\]$/, '').trim();
      if (q && !q.startsWith('CONFIDENCE')) {
        questions.push(q);
      }
    }
  }

  const afterConfidence = sqBlock.match(/CONFIDENCE:\s*[\d.]+\s*$/i);
  const remainingText = afterConfidence ? `${before}\n${afterConfidence[0]}` : before;

  return { text: remainingText, questions: questions.slice(0, 3) };
}

/**
 * Extract the CONFIDENCE: X.XX line from the LLM response.
 * Falls back to 0.5 if not found.
 */
function parseConfidence(text: string): { answer: string; confidence: number } {
  const trimmed = text.trim();
  if (
    trimmed === NO_INFO_RESPONSE ||
    trimmed === 'Мэдээлэл олдсонгүй' ||
    trimmed === `${NO_INFO_RESPONSE}\nCONFIDENCE: 0.00`
  ) {
    return { answer: NO_INFO_RESPONSE, confidence: 0 };
  }

  const match = text.match(/CONFIDENCE:\s*([\d.]+)\s*$/i);

  if (match) {
    const confidence = Math.max(0, Math.min(1, parseFloat(match[1])));
    const answer = text.slice(0, match.index).trimEnd();
    return { answer, confidence: Math.round(confidence * 100) / 100 };
  }

  return { answer: text, confidence: 0.5 };
}

function compactFallbackText(text: string, maxLen: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function isBroadIntentOverviewQuery(query: string, mode: QueryMode): boolean {
  if (mode !== 'qa') {
    return false;
  }

  if (extractRequestedArticleNumber(query)) {
    return false;
  }

  return BROAD_INTENT_OVERVIEW_PATTERN.test(normalizeForMatch(query));
}

function hasPreferredLawContext(
  chunks: ChromaQueryResult[],
  preferredLawIds: string[],
  intent: QueryIntent,
): boolean {
  if (chunks.length === 0 || preferredLawIds.length === 0) {
    return false;
  }

  const preferredSet = new Set(preferredLawIds);
  const lawHints = getIntentLawHint(intent)
    .split(';')
    .map((value) => normalizeForMatch(value))
    .filter(Boolean);

  return chunks.slice(0, 6).some((chunk) => {
    const lawId = String(chunk.metadata.sourceId ?? chunk.metadata.lawId ?? '');
    if (preferredSet.has(lawId)) {
      return true;
    }

    const corpus = normalizeForMatch(
      `${String(chunk.metadata.title ?? chunk.metadata.documentTitle ?? '')} ${String(chunk.document ?? '').slice(0, 800)}`,
    );
    return lawHints.some((hint) => corpus.includes(hint));
  });
}

function assessContextStrength(
  query: string,
  chunks: ChromaQueryResult[],
  intent: QueryIntent,
): 'strong' | 'weak' | 'none' {
  if (chunks.length === 0) {
    return intent === 'unknown' ? 'none' : 'weak';
  }

  const signalTerms = extractSignalTerms(query);
  const topChunks = chunks.slice(0, 5);
  const topScore = Number(topChunks[0]?.score ?? 0);

  let bestSignalRatio = signalTerms.length > 0 ? 0 : 0.4;
  let intentMatched = intent === 'unknown';

  for (const chunk of topChunks) {
    const title = String(chunk.metadata.title ?? chunk.metadata.documentTitle ?? '').trim();
    const corpus = normalizeForMatch(`${title} ${chunk.document?.slice(0, 1400) ?? ''}`);

    if (!intentMatched && matchesIntentInCorpus(intent, corpus)) {
      intentMatched = true;
    }

    if (signalTerms.length > 0) {
      const matchedTerms = signalTerms.filter((term) => corpus.includes(term)).length;
      bestSignalRatio = Math.max(bestSignalRatio, matchedTerms / signalTerms.length);
    }
  }

  if (intentMatched && (topScore >= 0.35 || bestSignalRatio >= 0.3)) {
    return 'strong';
  }

  if (intent !== 'unknown' && topScore >= 0.25) {
    return 'strong';
  }

  if (intent !== 'unknown') {
    return 'weak';
  }

  if (topScore >= 0.45 && bestSignalRatio >= 0.35) {
    return 'strong';
  }

  if (topScore >= 0.3) {
    return 'weak';
  }

  return 'none';
}

function buildIntentGuidanceFallback(
  intent: QueryIntent,
  query: string = '',
): {
  answer: string;
  confidence: number;
  suggestedQuestions: string[];
} {
  const lawHint = getIntentLawHint(intent);
  if (!lawHint) {
    return { answer: NO_INFO_RESPONSE, confidence: 0, suggestedQuestions: [] };
  }

  let brief = '';
  let actions: string[] = [];
  let suggestedQuestions: string[] = [];
  const trafficScenario = intent === 'traffic' ? resolveTrafficScenario(query) : 'general';

  switch (intent) {
    case 'crime':
      brief =
        'Энэ асуудал нь гэмт хэргийн шинжтэй байж болзошгүй тул хууль хяналтын байгууллагад яаралтай мэдэгдэх шаардлагатай.';
      actions = [
        'Цагдаагийн байгууллагад даруй мэдэгдэж өргөдөл гаргах.',
        'Баримт (утасны IMEI, худалдан авалтын баримт, мессеж, дуудлагын түүх)-аа хадгалах.',
        'Хохирлын хэмжээ, нөхцөл байдлыг бичгээр тодорхой тайлбарлах.',
      ];
      suggestedQuestions = [
        'Гэмт хэргийн талаар цагдаад ямар өргөдөл гаргах вэ?',
        'Хохирогчийн эрхийг хэрхэн хамгаалах вэ?',
        'Эрүүгийн хэрэг хянан шийдвэрлэх ажиллагаа хэрхэн явагддаг вэ?',
      ];
      break;
    case 'traffic':
      switch (trafficScenario) {
        case 'parking_hit_and_run':
          brief =
            'Зогсоолд байсан машиныг мөргөөд зугтсан тохиолдолд камер, гэрч, хамгаалалтын тэмдэглэл болон цагдаагийн бүртгэл хамгийн чухал.';
          actions = [
            'Гэмтлийг хөдөлгөхөөс өмнө олон өнцгөөс зураг, видео, огноо цагтай баримтаа хадгал.',
            'Зогсоолын харуул, СӨХ, хамгаалалтаас камерын бичлэг хадгалах хүсэлт даруй гарга.',
            '102-т мэдэгдэж бүртгүүлэн, даатгалтай бол даатгагчдаа хугацаа алдалгүй мэдэгд.',
          ];
          suggestedQuestions = [
            'Зогсоолын камерын бичлэгийг хэрхэн баримтжуулж авах вэ?',
            'Мөргөөд зугтсан хохирлыг даатгалаар шийдүүлж болох уу?',
            'Зогсоолд гарсан ослыг замын цагдаад хэрхэн бүртгүүлэх вэ?',
          ];
          break;
        case 'hit_and_run':
          brief =
            'Зам тээврийн ослын дараа нөгөө жолооч зугтсан бол ослын газар дээрх ул мөр, гэрч, дэшкам болон цагдаагийн бүртгэл хэргийг шийдэх суурь нотолгоо болдог.';
          actions = [
            'Ослын газрын зураг, тээврийн хэрэгслийн үлдсэн хэлтэрхий, мөр, цаг хугацааг нарийвчлан баримтжуул.',
            'Гэрчийн утас, машины улсын дугаарын хэсэг, камер ба дэшкамын мэдээллийг цуглуул.',
            'Цагдаа болон даатгалдаа мэдэгдэж, үзлэгийн акт, хохирлын үнэлгээг албан ёсоор гаргуул.',
          ];
          suggestedQuestions = [
            'Зугтсан жолоочийг илрүүлэхэд ямар нотолгоо хамгийн чухал вэ?',
            'Зам тээврийн ослыг даатгалаар шийдүүлэх хугацаа хэр вэ?',
            'Ослын газраас зугтсан тохиолдолд хэнд нэхэмжлэл гаргах вэ?',
          ];
          break;
        case 'opposite_lane_collision':
          brief =
            'Эсрэг урсгалаас орж ирсэн машинтай мөргөлдсөн тохиолдолд буруутай талыг замын тэмдэг, тэмдэглэгээ, камер, гэрч ба мөргөлдсөн цэгээр тогтооно.';
          actions = [
            'Хүн гэмтсэн бол түрүүнд аюулгүй байдлыг хангаж 103, 102-т мэдэгд.',
            'Эсрэг урсгал орсон чиглэл, шугам, тэмдэг, мөргөлдсөн цэг, тоормосны мөрийг зурагла.',
            'Гэрч, дэшкам, орчны камерын бичлэгийг цуглуулж даатгал болон цагдаад үндсэн баримт болгож өг.',
          ];
          suggestedQuestions = [
            'Эсрэг урсгалаас орсон бурууг хэрхэн нотлох вэ?',
            'Зам тээврийн осолд гэрчийн мэдүүлгийг хэрхэн баримтжуулах вэ?',
            'Эсрэг урсгалтай ослын хохирлыг даатгалаар шийдүүлж болох уу?',
          ];
          break;
        case 'parking_collision':
          brief =
            'Зогсоолд гарсан мөргөлтийн үед машины байршил, зогсолтын шугам, камер, гэрчийн мэдээлэл хохирол хэн хариуцахыг тогтоох гол нотолгоо болно.';
          actions = [
            'Машины байршил болон гэмтлийг олон өнцгөөс зураг, видеогоор баримтаар хадгал.',
            'Орчны камер, харуулын тэмдэглэл, гэрчийн мэдүүлгийг цуглуулж цагдаад бүртгүүл.',
            'Даатгалтай бол даатгагчдаа мэдэгдэж үзлэгийн акт, үнэлгээг гаргуул.',
          ];
          suggestedQuestions = [
            'Зогсоолд гарсан осолд буруутай талыг хэрхэн тогтоох вэ?',
            'Машины гэмтлийн үнэлгээг хаана хийлгэх вэ?',
            'Зогсоолын мөргөлтийг даатгалаар шийдүүлэх алхам юу вэ?',
          ];
          break;
        case 'collision':
          brief =
            'Зам тээврийн осолд орсон тохиолдолд ослын газрыг зөв баримтжуулах, цагдаа болон даатгалдаа хугацаанд мэдэгдэх нь хариуцлага, нөхөн төлбөрийн суурь болдог.';
          actions = [
            'Ослын газрын зураг, видео, гэмтлийн баримт, гэрчийн мэдээллийг цуглуул.',
            'Замын цагдаад бүртгүүлж, хохиролтой холбоотой акт гаргуул.',
            'Даатгалтай бол хохирлын үнэлгээ, засварын төсөв, эмнэлгийн зардлаа бүрдүүлж өг.',
          ];
          suggestedQuestions = [
            'Зам тээврийн ослын актад юу тусгах ёстой вэ?',
            'Ослын хохирлыг нөхөн төлүүлэхэд ямар баримт хэрэгтэй вэ?',
            'Зам тээврийн осолд даатгалд хэдийд мэдэгдэх вэ?',
          ];
          break;
        default:
          brief =
            'Тээврийн хэрэгслийг согтуугаар жолоодох нь нөхцөл байдлаас хамааран зөрчил эсвэл эрүүгийн хариуцлага хүлээлгэх эрсдэлтэй.';
          actions = [
            'Согтууруулах ундаа хэрэглэсэн үед жолоо барихаас татгалзаж, аюулгүй тээврийн сонголт ашиглах.',
            'Шалгалт, акт тогтоолтод орсон бол баримт бичиг, шинжилгээний хариуг бүрэн авч хадгалах.',
            'Торгууль, эрх хасалт, эрүүгийн хэрэг үүсэх эсэхийг хуульчтай зөвлөн нягтлах.',
          ];
          suggestedQuestions = [
            'Согтуугаар жолоодвол ямар торгууль ногдуулдаг вэ?',
            'Жолоодох эрхийг хэдэн жилээр хасдаг вэ?',
            'Замын хөдөлгөөний осолд орсон бол яах вэ?',
          ];
          break;
      }
      break;
    case 'election':
      brief =
        'Сонгогчийн эрх ба насны босгыг Үндсэн хууль болон Сонгуулийн тухай хуулиар зохицуулдаг бөгөөд нийтлэг босго нь 18 нас байдаг.';
      actions = [
        'Сонгогчийн эрх, насны шалгуурыг Сонгуулийн тухай хуулийн холбогдох заалтаас нягтлах.',
        'Тодорхой сонгуулийн төрөл (УИХ, орон нутаг гэх мэт)-ийн тусгай шаардлагыг ялгаж шалгах.',
        'Сонгогчийн бүртгэл, үнэмлэхтэй холбоотой асуудлыг харьяа сонгуулийн байгууллагаас лавлах.',
      ];
      suggestedQuestions = [
        'Сонгуулийн тухай хуулиар нэр дэвшигчид ямар шаардлага тавьдаг вэ?',
        'Сонгогчийн бүртгэлд хэрхэн бүртгүүлэх вэ?',
        'Сонгуулийн зөрчлийг хаана мэдэгдэх вэ?',
      ];
      break;
    case 'contract':
      if (/худалдах|худалдан|зарах|шилжүүлэх|эд\s*хөрөнгө|үл\s*хөдлөх|өмчлөх/i.test(query)) {
        brief =
          'Эд хөрөнгө (ялангуяа үл хөдлөх хөрөнгө) худалдах, худалдан авах, өмчлөх эрх шилжүүлэх харилцааг Иргэний хууль болон холбогдох бүртгэлийн журмаар зохицуулна.';
        actions = [
          'Худалдах-худалдан авах гэрээг бичгээр байгуулж, нөхцөлийг тодорхой тусгах.',
          'Шаардлагатай тохиолдолд нотариатаар баталгаажуулж улсын бүртгэлд шилжилтийг бүртгүүлэх.',
          'Татвар, хураамж, төлбөрийн үүргийг хуульд заасан хугацаанд биелүүлэх.',
        ];
        suggestedQuestions = [
          'Үл хөдлөх хөрөнгийн гэрээг хэрхэн баталгаажуулах вэ?',
          'Эд хөрөнгийн маргааныг шүүхэд хэрхэн шийдвэрлүүлэх вэ?',
          'Нотариатаар баталгаажуулах ямар шаардлагатай вэ?',
        ];
      } else {
        brief =
          'Гэрээний төлбөр төлөөгүй асуудал нь иргэний эрх зүйн үүргийн биелэлттэй холбоотой маргаан байна.';
        actions = [
          'Гэрээ болон төлбөрийн нөхцөлийг баримтаар нэгтгэж албан шаардлага хүргүүлэх.',
          'Төлбөр барагдуулах хугацаа тогтоож бичгээр сануулах.',
          'Шаардлага биелэхгүй бол эвлэрүүлэн зуучлал эсвэл шүүхэд нэхэмжлэл гаргах.',
        ];
        suggestedQuestions = [
          'Гэрээний төлбөр барагдуулахгүй бол шүүхэд хэрхэн хандах вэ?',
          'Аман гэрээг шүүх дээр хэрхэн нотлох вэ?',
          'Эвлэрүүлэн зуучлалын журам хэрхэн ажилладаг вэ?',
        ];
      }
      break;
    case 'tax':
      brief =
        'Татвар төлөөгүй асуудал нь татварын хууль тогтоомжийн дагуух үүргийн зөрчилд тооцогдож болзошгүй.';
      actions = [
        'Татварын өр, алдангийн тооцооллоо татварын системээс шалгах.',
        'Татварын байгууллагад тайлбар, нөхөн төлөлтийн хүсэлт гаргах.',
        'Төлөлтийн хуваарь, торгууль бууруулах боломжийг хуульд нийцүүлэн тодруулах.',
      ];
      suggestedQuestions = [
        'Татварын алдангийг хэрхэн тооцдог вэ?',
        'Татварын маргааныг хаана шийдвэрлүүлэх вэ?',
        'Татварын хөнгөлөлт, чөлөөлөлт авах боломж бий юу?',
      ];
      break;
    case 'family':
      brief =
        'Асуудал нь гэр бүлийн эрх зүйн харилцаанд хамаарах тул талуудын эрх, үүргийг хуульд нийцүүлэн тодруулах шаардлагатай.';
      actions = [
        'Холбогдох баримт бичиг (гэрлэлт, хүүхэд, тэтгэлэг зэрэг)-ийг бүрдүүлэх.',
        'Эвлэрүүлэн зуучлал, гэр бүлийн зөвлөгөөний боломжийг ашиглах.',
        'Маргаан шийдэгдэхгүй бол эрх бүхий байгууллагад албан ёсоор хандах.',
      ];
      suggestedQuestions = [
        'Гэрлэлт цуцлах ажиллагаа хэрхэн явагддаг вэ?',
        'Хүүхдийн тэтгэлгийн хэмжээг хэрхэн тогтоодог вэ?',
        'Хүүхдийн асран хамгаалагчийг хэрхэн тогтоодог вэ?',
      ];
      break;
    case 'labor':
      brief =
        'Асуудал нь хөдөлмөрийн харилцааны хүрээнд ажилтан, ажил олгогчийн эрх үүрэгтэй холбоотой.';
      actions = [
        'Хөдөлмөрийн гэрээ, тушаал, цалингийн баримт зэрэг нотлох материалыг бүрдүүлэх.',
        'Ажил олгогчид бичгээр шаардлага хүргүүлж хариу авах.',
        'Шаардлагатай бол хөдөлмөрийн маргаан шийдвэрлэх байгууллагад хандах.',
      ];
      suggestedQuestions = [
        'Хөдөлмөрийн гэрээг ажил олгогч хууль бусаар цуцалсан бол яах вэ?',
        'Ажилтны цалин хөлсийг хоцроосон бол ямар арга хэмжээ авах вэ?',
        'Хөдөлмөрийн маргаан шийдвэрлэх комисст хэрхэн хандах вэ?',
      ];
      break;
    case 'socialInsurance':
      brief =
        'Нийгмийн даатгалын шимтгэл төлөөгүй асуудал нь даатгуулагчийн эрх ашигт шууд нөлөөлөх тул яаралтай шалгах шаардлагатай.';
      actions = [
        'Нийгмийн даатгалын шимтгэлийн төлөлтийн мэдээллээ цахимаар болон харьяа нэгжээр шалгах.',
        'Ажил олгогчид шимтгэл нөхөн төлүүлэх талаар бичгээр шаардлага тавих.',
        'Биелүүлэхгүй бол Нийгмийн даатгалын байгууллага болон хяналтын байгууллагад гомдол гаргах.',
      ];
      suggestedQuestions = [
        'Нийгмийн даатгалын шимтгэлийн хэмжээг хэрхэн тооцдог вэ?',
        'Тэтгэврийн даатгалд хэдэн жил шимтгэл төлсөн байх шаардлагатай вэ?',
        'Ажил олгогч шимтгэл төлөөгүй бол ажилтан яах вэ?',
      ];
      break;
    default:
      return { answer: NO_INFO_RESPONSE, confidence: 0, suggestedQuestions: [] };
  }

  const citationLines = buildIntentFallbackCitationLines(intent, query);
  const riskGuidance = buildQaRiskGuidance(intent, query);
  const practicalTips = buildQaPracticalTips(intent, query);

  const answer = [
    '1. Товч хариулт',
    brief,
    '',
    '2. Холбогдох хуулийн заалт (дарж эхийг нээнэ үү)',
    ...citationLines,
    citationLines.length > 0
      ? '- Дээрх холбоосууд нь legalinfo.mn дээрх эх хууль руу шууд нээгдэнэ.'
      : `- ${lawHint}`,
    '',
    '3. Яаралтай авах арга хэмжээ',
    ...actions.map((action, idx) => `${idx + 1}. ${action}`),
    '',
    '4. Эрсдэл, анхаарах нөхцөл',
    riskGuidance,
    'Хуулийн заалт хэрэглэхдээ тухайн гэрээ, тушаал, акт, мэдэгдэл болон хугацааны баримттайгаа заавал тулгаж шалгана.',
    '',
    '**Практик зөвлөгөө**',
    ...practicalTips.map((tip) => `- ${tip}`),
  ].join('\n');

  return { answer, confidence: 0.42, suggestedQuestions };
}

function buildIntentFallbackCitationLines(intent: QueryIntent, query: string): string[] {
  const requestedArticle = extractRequestedArticleNumber(query);
  const trafficScenario = intent === 'traffic' ? resolveTrafficScenario(query) : 'general';

  const makeCitation = (
    abbrev: string,
    articleNo: string,
    lawId: string,
    sword: string,
    note: string,
  ): string => {
    const swordKeyword = normalizeArticleNumber(articleNo) || sword;
    const url = `https://legalinfo.mn/mn/detail?lawId=${lawId}&sword=${encodeURIComponent(swordKeyword)}`;
    return `- [${abbrev}-ийн §${articleNo}](${url}) — ${note}`;
  };

  switch (intent) {
    case 'family': {
      const primaryArticle = requestedArticle || '33.1';
      return [
        makeCitation(
          'ГБТ',
          primaryArticle,
          '226',
          'харилцах эрх',
          'Эцэг, эх хүүхэдтэйгээ харилцах суурь зохицуулалт.',
        ),
        makeCitation(
          'ГБТ',
          '33.2',
          '226',
          'харилцах эрх',
          'Уулзах, харилцах нөхцөл, шүүхийн зохицуулалттай холбоотой.',
        ),
        makeCitation(
          'ГБТ',
          '36.1',
          '226',
          'асран хамгаалах',
          'Хүүхдийн дээд ашиг сонирхлыг нэн тэргүүнд тооцох зарчим.',
        ),
        makeCitation(
          'ИХШТ',
          '65.1',
          '11220',
          'гэр бүл',
          'Шүүхэд нэхэмжлэл, хүсэлт гаргах процессын суурь шаардлага.',
        ),
      ];
    }
    case 'contract':
      return [
        makeCitation(
          'ИХ',
          '225.1',
          '299',
          'үүрэг',
          'Гэрээний үүргийг хугацаанд нь гүйцэтгэх үндсэн шаардлага.',
        ),
        makeCitation(
          'ИХ',
          '229.1',
          '299',
          'алданги',
          'Хугацаа хэтрүүлбэл алданги, хариуцлагын суурь зохицуулалт.',
        ),
        makeCitation(
          'ИХ',
          '224.1',
          '299',
          'хохирол',
          'Хохирол нөхөн төлүүлэх эрхийн үндсэн суурь.',
        ),
      ];
    case 'labor':
      return [
        makeCitation(
          'ХТ',
          '43.1',
          '16230709635751',
          'хөдөлмөрийн гэрээ',
          'Хөдөлмөрийн гэрээний гол нөхцөл, үүрэг.',
        ),
        makeCitation(
          'ХТ',
          '57.1',
          '16230709635751',
          'цалин',
          'Цалин олголт, хугацаатай холбоотой суурь шаардлага.',
        ),
        makeCitation(
          'ХТ',
          '80.1',
          '16230709635751',
          'цуцлах',
          'Гэрээ дуусгавар болгох үеийн эрх, үүргийн суурь зохицуулалт.',
        ),
      ];
    case 'traffic':
      if (trafficScenario === 'dui') {
        return [
          makeCitation(
            'ЗТ',
            '14.7',
            '12695',
            'жолоодох эрх',
            'Согтуугаар жолоодохтой холбоотой зөрчлийн хариуцлага.',
          ),
          makeCitation(
            'ЗХАБТХ',
            '5.1',
            '11224',
            'жолооч',
            'Жолоочийн нийтлэг үүрэг, аюулгүй ажиллагааны шаардлага.',
          ),
          makeCitation(
            'ЭХ',
            '27.10',
            '12172',
            'согтуугаар',
            'Нөхцөл хүндрэх үед эрүүгийн хариуцлагын эрсдэл.',
          ),
        ];
      }

      return [
        makeCitation(
          'ЗХАБТХ',
          '5.1',
          '11224',
          'жолооч',
          'Жолооч осол, зөрчилд холбогдсон үед аюулгүй ажиллагаа, нийтлэг үүргээ хэрэгжүүлэх суурь зохицуулалт.',
        ),
        makeCitation(
          'АТТ',
          '12.1',
          '29',
          'тээврийн хэрэгсэл',
          'Тээврийн хэрэгслийн ашиглалт, баримт бичиг, холбогдох харилцааны суурь хүрээ.',
        ),
        makeCitation(
          'ЭХ',
          '27.10',
          '12172',
          'тээврийн хэрэгсэл',
          'Ослын улмаас хүнд гэмтэл, амь насанд аюул учирсан бол эрүүгийн хариуцлага үүсэх эрсдэл.',
        ),
      ];
    case 'crime':
      return [
        makeCitation(
          'ЭХ',
          '17.1',
          '12172',
          'гэмт хэрэг',
          'Гэмт хэргийн шинж, ял шийтгэлийн суурь зохицуулалт.',
        ),
        makeCitation(
          'ЭХШТ',
          '1.1',
          '12694',
          'эрүүгийн хэрэг',
          'Эрүүгийн хэрэг хянан шийдвэрлэх ажиллагааны суурь зарчим.',
        ),
      ];
    case 'election':
      return [
        makeCitation(
          'ҮХ',
          '16.9',
          '367',
          'сонгох эрх',
          'Сонгох, сонгогдох эрхийн үндсэн баталгаа.',
        ),
      ];
    case 'tax':
      return [
        makeCitation(
          'ТЕХ',
          '1.1',
          '13830',
          'татвар',
          'Татвар төлөгчийн үүрэг, хариуцлагын суурь хүрээ.',
        ),
      ];
    case 'socialInsurance':
      return [
        makeCitation(
          'НДЕХ',
          '1.1',
          '12297',
          'шимтгэл',
          'Нийгмийн даатгалын шимтгэлийн эрх, үүргийн суурь хүрээ.',
        ),
      ];
    default:
      return [];
  }
}

function matchesIntentInCorpus(intent: QueryIntent, corpus: string): boolean {
  if (intent === 'unknown') {
    return true;
  }

  // Off-topic criminal articles (money laundering, human trafficking, terrorism,
  // state security, etc.) bleed through into traffic / contract / labor results
  // because the embedding picks up shared legal terminology. Reject them
  // unconditionally for non-crime intents.
  if (intent !== 'crime' && isOffTopicCriminalChunk(corpus)) {
    return false;
  }

  switch (intent) {
    case 'crime':
      return /(эрүүгийн|гэмт\s+хэрэг|хулгай|залилан|залилах|авлига|хүчирхийлэл|хууран|мэхл)/i.test(
        corpus,
      );
    case 'traffic': {
      const hasTrafficCore =
        /(замын\s+хөдөлгөөн|тээврийн\s+хэрэгсэл|жолоо|жолоод|жолооч|согтуур|согтуу|осол|мөргө|мөргөлд|шүрг|шүргэ|зугт|ослын\s+газар|эсрэг\s+урсгал|зогсоол|паркинг|авто\s*даатгал|каско)/i.test(
          corpus,
        );
      const hasTrafficLiabilityWord = /(зөрчил|торгууль|хариуцлага|нөхөн\s*төлбөр|даатгал)/i.test(
        corpus,
      );
      const hasCriminalWord = /(эрүүгийн|гэмт\s+хэрэг|ял|хорих|тэнсэх)/i.test(corpus);
      // Keep a chunk if it mentions a traffic-specific term, OR if it ties a
      // generic liability/criminal reference to traffic context. Pure
      // criminal-only chunks (no traffic word) are rejected.
      return hasTrafficCore || (hasTrafficLiabilityWord && hasCriminalWord);
    }
    case 'election':
      return /(сонгууль|сонгогч|сонгох\s+эрх|санал\s+өгөх|үндсэн\s+хууль|18\s*нас|арван\s*найм)/i.test(
        corpus,
      );
    case 'contract':
      return /(иргэний|гэрээ|худалдах|худалдан|зарах|шилжүүл|хөрөнгө|үл\s*хөдлөх|өмчлөх|түрээс|хохирол|нөхөн\s*төлбөр|үүрэг)/i.test(
        corpus,
      );
    case 'tax':
      return /(татвар|албан\s+татвар|алданги|нөат)/i.test(corpus);
    case 'family':
      return /(гэр\s+бүл|гэрлэлт|салалт|тэтгэлэг|хүүхэд)/i.test(corpus);
    case 'labor':
      return /(хөдөлмөр|ажилтн|ажилч|ажил\s+олгогч|цалин|хөдөлмөрийн\s+гэрээ)/i.test(corpus);
    case 'socialInsurance':
      return /(нийгмийн\s+даатгал|шимтгэл|даатгуулагч|ндш)/i.test(corpus);
    default:
      return false;
  }
}

/**
 * Returns true for criminal-law chunks that almost always belong to other
 * domains — money laundering, trafficking, terrorism, weapons, organised
 * crime, state-security articles. Used to keep these out of traffic / labor /
 * contract / family answers where the embedding model occasionally surfaces
 * them due to shared legal vocabulary ("хариуцлага", "ял", etc.).
 */
function isOffTopicCriminalChunk(corpus: string): boolean {
  return /(мөнгө\s+угаах|хүн\s+худалдаалах|терроризм|террорист|зэвсэгт\s+халдлага|улсын\s+нууц|төрийн\s+эсрэг|зохион\s+байгуулалттай\s+гэмт|хар\s+тамхи|мансууруулах\s+бодис|олон\s+нийтийн\s+аюулгүй\s+байдлын\s+эсрэг|хүн\s+худалдаалах\s+гэмт)/i.test(
    corpus,
  );
}

function inferIntentFromChunks(chunks: ChromaQueryResult[]): QueryIntent {
  if (chunks.length === 0) {
    return 'unknown';
  }

  const intents: Exclude<QueryIntent, 'unknown'>[] = [
    'crime',
    'traffic',
    'election',
    'contract',
    'tax',
    'socialInsurance',
    'labor',
    'family',
  ];

  const scores = new Map<QueryIntent, number>();
  for (const intent of intents) {
    scores.set(intent, 0);
  }

  for (const chunk of chunks.slice(0, 6)) {
    const corpus = normalizeForMatch(
      `${String(chunk.metadata.title ?? chunk.metadata.documentTitle ?? '')} ${chunk.document?.slice(0, 1800) ?? ''}`,
    );
    const weight = Math.max(0.2, Number(chunk.score) || 0.2);

    for (const intent of intents) {
      if (matchesIntentInCorpus(intent, corpus)) {
        scores.set(intent, (scores.get(intent) ?? 0) + weight);
      }
    }
  }

  let bestIntent: QueryIntent = 'unknown';
  let bestScore = 0;
  for (const [intent, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  return bestScore > 0 ? bestIntent : 'unknown';
}

function extractSignalTerms(query: string): string[] {
  const normalized = normalizeForMatch(query);
  const stopTerms = new Set([
    'ямар',
    'хэдэн',
    'хариуцлага',
    'хүлээх',
    'тухай',
    'хууль',
    'хуулийн',
    'хуульд',
    'заалт',
    'зүйл',
    'журам',
    'дүрэм',
    'бол',
    'нь',
    'вэ',
    'уу',
    'яах',
    'яавал',
    'эрүүгийн',
    'иргэний',
    'татвар',
    'нийгмийн',
    'даатгал',
    'хөдөлмөр',
    'гэрээ',
    'гэр',
    'бүл',
    'эх',
    'аль',
    'нэг',
    'байвал',
    'гэмт',
    'хэрэг',
    'дугаар',
    'дүгээр',
    'юу',
  ]);

  const rawTerms = normalized
    .split(/\s+/)
    .map((term) => stemMongolianToken(term))
    .filter((term) => term.length >= 3 && !stopTerms.has(term));

  return Array.from(new Set(rawTerms)).slice(0, 6);
}

function isGenericUnscopedLegalQuestion(query: string): boolean {
  const normalized = normalizeForMatch(query);
  const genericLiabilityPattern =
    /(ямар\s+хуулийн\s+хариуцлага|хуулийн\s+хариуцлага\s+хүлээх|ямар\s+хариуцлага\s+хүлээх)/i;

  if (!genericLiabilityPattern.test(normalized)) {
    return false;
  }

  const hasSpecificContext =
    /(согтуур|согтуу|жолоо|мөргө|мөргөлд|шүрг|шүргэ|зугт|осол|ослын\s+газар|эсрэг\s+урсгал|зогсоол|паркинг|авто\s*даатгал|каско|сонгууль|сонгогч|гэрээ|татвар|даатгал|хөдөлмөр|гэр\s+бүл|хулгай|залилан|эд\s*хөрөнгө|үл\s*хөдлөх|өмч|шилжүүл|хүчирхийлэл)/i.test(
      normalized,
    );

  return !hasSpecificContext;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}\\/\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemMongolianToken(token: string): string {
  return token.replace(
    /(ийн|ын|ийг|ыг|аа|ээ|оо|өө|аас|ээс|д|т|аар|ээр|оор|өөр|тай|тэй|гүй|ууд|үүд|нууд|нүүд)$/iu,
    '',
  );
}

function filterChunksByIntent(
  intent: QueryIntent,
  chunks: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (intent === 'unknown' || chunks.length === 0) {
    return chunks;
  }

  return chunks.filter((chunk) => {
    const corpus = normalizeForMatch(
      `${String(chunk.metadata.title ?? chunk.metadata.documentTitle ?? '')} ${chunk.document?.slice(0, 1600) ?? ''}`,
    );

    if (isInternationalOrUnrelatedTreaty(corpus)) {
      return false;
    }

    return matchesIntentInCorpus(intent, corpus);
  });
}

function isInternationalOrUnrelatedTreaty(corpus: string): boolean {
  return /(олон\s+улсын|конвенц|протокол|санамж\s+бичиг|харилцан\s+ойлголцол|олимп)/i.test(corpus);
}

function collectContextArticleNumbers(
  query: string,
  mode: QueryMode,
  chunks: ChromaQueryResult[],
): string[] {
  const requestedArticle = extractRequestedArticleNumber(query);
  if (requestedArticle) {
    for (const chunk of chunks.slice(0, 5)) {
      const aligned = extractQueryAlignedArticleNumber(query, chunk);
      if (aligned === requestedArticle) {
        return [requestedArticle];
      }
    }

    return [];
  }

  const scored = new Map<string, number>();
  for (const chunk of chunks.slice(0, mode === 'qa' ? 6 : 5)) {
    const aligned = extractQueryAlignedArticleNumber(query, chunk);
    const fallback = normalizeArticleNumber(String(chunk.metadata.articleNo ?? ''));
    const candidates = Array.from(new Set([aligned, fallback].filter(Boolean)));

    for (const candidate of candidates) {
      scored.set(candidate, (scored.get(candidate) ?? 0) + Math.max(Number(chunk.score) || 0, 0.1));
    }
  }

  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([article]) => article)
    .slice(0, mode === 'qa' ? 4 : 3);
}

function enforceArticleGrounding(
  answer: string,
  allowedArticles: string[],
  mode: QueryMode,
): { answer: string; adjusted: boolean } {
  const answerTrimmedLower = answer.trim().toLowerCase();
  const noInfoText = NO_INFO_RESPONSE.toLowerCase();
  if (
    answerTrimmedLower === noInfoText ||
    answerTrimmedLower === 'мэдээлэл олдсонгүй' ||
    answerTrimmedLower.startsWith(`${noInfoText}\n`) ||
    answerTrimmedLower.startsWith(`${noInfoText} `)
  ) {
    return { answer: NO_INFO_RESPONSE, adjusted: answer.trim() !== NO_INFO_RESPONSE };
  }

  const allowed = new Set(
    allowedArticles.map((article) => normalizeArticleNumber(article)).filter(Boolean),
  );
  const detected = extractArticleRefsFromAnswer(answer);

  if (mode === 'article') {
    const normalizedAllowed = Array.from(allowed);
    const updated = upsertArticleModeSection(answer, normalizedAllowed);
    return {
      answer: updated,
      adjusted: updated !== answer || detected.length === 0,
    };
  }

  if (mode === 'document') {
    if (allowed.size === 0) {
      if (detected.length === 0) {
        return { answer, adjusted: false };
      }

      const updated = upsertDocumentFirstArticleLine(answer, []);
      return { answer: updated, adjusted: true };
    }

    const invalid = detected.filter((article) => !allowed.has(normalizeArticleNumber(article)));
    if (invalid.length > 0 || detected.length === 0) {
      const updated = upsertDocumentFirstArticleLine(answer, Array.from(allowed));
      return { answer: updated, adjusted: true };
    }

    return { answer, adjusted: false };
  }

  if (allowed.size === 0) {
    if (detected.length === 0) {
      return { answer, adjusted: false };
    }

    return {
      answer: upsertArticleSection(answer, []),
      adjusted: true,
    };
  }

  const invalid = detected.filter((article) => !allowed.has(normalizeArticleNumber(article)));
  if (invalid.length > 0 || detected.length === 0) {
    return {
      answer: upsertArticleSection(answer, Array.from(allowed) as string[]),
      adjusted: true,
    };
  }

  return { answer, adjusted: false };
}

function upsertArticleSection(answer: string, allowedArticles: string[]): string {
  const sectionBody =
    allowedArticles.length > 0
      ? `Эх сурвалжид ${allowedArticles
          .map((article) => `${article} дугаар зүйл`)
          .join(', ')} холбогдож байгаа тул эдгээр заалтыг зөвхөн дугаарын жагсаалт биш, таны бодит нөхцөлд үүсэх эрх, үүрэг, шаардлагатай нь холбож тайлбарлах хэрэгтэй.`
      : 'Эх сурвалжаас энэ нөхцөлд шууд хэрэглэх тодорхой зүйл илрээгүй тул хуулийн зүйл дугаарыг зохиож нэмэхгүй. Ийм үед баримтаа бүрдүүлж, эрх бүхий байгууллага эсвэл нөгөө талаас бичгээр тодруулга авах нь илүү найдвартай.';
  const section = `**Хуулийн тайлбар**\n${sectionBody}`;

  return `${answer.trim()}\n\n${section}`;
}

function upsertArticleModeSection(answer: string, allowedArticles: string[]): string {
  const line =
    allowedArticles.length > 0
      ? `Зүйл, заалт: ${allowedArticles.map((article) => `${article} дугаар зүйл`).join(', ')}`
      : 'Зүйл, заалт: Контекстэд баталгаатай зүйл илрээгүй.';

  if (/^\s*Зүйл,\s*заалт\s*:/im.test(answer)) {
    return answer.replace(/^\s*Зүйл,\s*заалт\s*:.*$/im, line).trim();
  }

  if (/^\s*Хуулийн\s+нэр\s*:/im.test(answer)) {
    return answer.replace(/^\s*Хуулийн\s+нэр\s*:.*$/im, (match) => `${match}\n${line}`).trim();
  }

  return `${answer.trim()}\n${line}`.trim();
}

function upsertDocumentFirstArticleLine(answer: string, allowedArticles: string[]): string {
  const line =
    allowedArticles.length > 0
      ? `Эхний зүйл: ${allowedArticles[0]} дугаар зүйл`
      : 'Эхний зүйл: Контекстэд тодорхой зүйл илрээгүй.';

  if (/^\s*Эхний\s+зүйл\s*:/im.test(answer)) {
    return answer.replace(/^\s*Эхний\s+зүйл\s*:.*$/im, line).trim();
  }

  return `${answer.trim()}\n${line}`.trim();
}

function extractArticleRefsFromAnswer(answer: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /(\d+(?:\.\d+)*)\s*(?:-?р|дүгээр|дугаар)?\s*зүйл/giu,
    /зүйл\s*(\d+(?:\.\d+)*)/giu,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(answer)) !== null) {
      const normalized = normalizeArticleNumber(match[1] ?? '');
      if (normalized) {
        refs.add(normalized);
      }
    }
  }

  return Array.from(refs);
}

function normalizeArticleNumber(article: string): string {
  const trimmed = article.trim();
  const match = trimmed.match(/\d+(?:\.\d+)*/);
  if (!match) {
    return '';
  }

  const value = match[0];
  if (/^\d+$/.test(value) && Number(value) > 500) {
    return '';
  }

  return value;
}

type ArticleMarker = {
  articleNo: string;
  index: number;
};

function extractPrimaryQuery(query: string): string {
  const firstLine = query
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? query.trim();
}

function extractRequestedArticleNumber(query: string): string {
  const match = query.match(
    /(?:([0-9]+(?:\.[0-9]+)*)\s*(?:дугаар|дүгээр)\s*(?:зүйл|заалт|хэсэг)|(?:зүйл|заалт)\s*([0-9]+(?:\.[0-9]+)*))/iu,
  );
  const raw = match?.[1] ?? match?.[2] ?? '';
  return normalizeArticleNumber(raw);
}

function extractArticleMarkers(document: string): ArticleMarker[] {
  if (!document) {
    return [];
  }

  const markers: ArticleMarker[] = [];
  const patterns = [
    /(\d+(?:\.\d+)*)\s+(?:дугаар|дүгээр)\s+зүйл/giu,
    /зүйл\s*(\d+(?:\.\d+)*)/giu,
    /article\s*(\d+(?:\.\d+)*)/giu,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(document)) !== null) {
      const articleNo = normalizeArticleNumber(match[1] ?? '');
      if (!articleNo) {
        continue;
      }
      markers.push({ articleNo, index: match.index });
    }
  }

  markers.sort((a, b) => a.index - b.index);

  const deduped: ArticleMarker[] = [];
  for (const marker of markers) {
    const last = deduped[deduped.length - 1];
    if (last && last.articleNo === marker.articleNo && Math.abs(last.index - marker.index) < 6) {
      continue;
    }
    deduped.push(marker);
  }

  return deduped;
}

function extractQueryAlignedArticleNumber(query: string, chunk: ChromaQueryResult): string {
  const document = String(chunk.document ?? '');
  const markers = extractArticleMarkers(document);
  const requestedArticle = extractRequestedArticleNumber(query);
  const signalTerms = extractSignalTerms(query).filter((term) => term.length >= 4);

  if (requestedArticle) {
    return markers.some((marker) => marker.articleNo === requestedArticle) ? requestedArticle : '';
  }

  if (markers.length === 0) {
    const fromText = normalizeArticleNumber(extractArticle(document) ?? '');
    const fromMeta = normalizeArticleNumber(String(chunk.metadata.articleNo ?? ''));
    if (!fromText) {
      return '';
    }
    if (fromMeta && fromMeta !== fromText) {
      return '';
    }
    return fromText;
  }

  if (signalTerms.length === 0) {
    return markers.length === 1 ? markers[0].articleNo : '';
  }

  let bestArticle = '';
  let bestMatched = 0;
  let bestRatio = 0;

  for (let i = 0; i < markers.length; i += 1) {
    const current = markers[i];
    const next = markers[i + 1];
    const segment = normalizeForMatch(
      document.slice(current.index, next?.index ?? document.length),
    );
    const matched = signalTerms.filter((term) => segment.includes(term)).length;
    const ratio = matched / signalTerms.length;
    if (matched > bestMatched) {
      bestMatched = matched;
      bestRatio = ratio;
      bestArticle = current.articleNo;
    }
  }

  if (bestMatched > 0 && (bestMatched >= 2 || bestRatio >= MIN_ARTICLE_SIGNAL_RATIO)) {
    return bestArticle;
  }

  return '';
}

export { SYSTEM_PROMPT };
