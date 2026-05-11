'use client';

export interface FlowStep {
  label: string;
  isDecision?: boolean;
}

export function extractFlowSteps(text: string): FlowStep[] {
  if (!text) return [];

  const steps: FlowStep[] = [];
  const lines = text.split('\n');
  let inActionSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^#{1,3}\s*(?:Яг одоо хийх алхам|Яаралтай авах арга хэмжээ)/i.test(trimmed)) {
      inActionSection = true;
      continue;
    }

    if (/^#{1,3}\s+/i.test(trimmed) && !/^#{1,3}\s*(?:Яг одоо хийх алхам|Яаралтай авах арга хэмжээ)/i.test(trimmed)) {
      inActionSection = false;
    }

    if (inActionSection) {
      const numberedStep = trimmed.match(/^\d+\.\s+(.+)/);
      if (numberedStep) {
        const label = numberedStep[1].trim().replace(/:$/, '');
        if (label.length >= 3 && label.length <= 120) {
          steps.push({ label, isDecision: /\?|эсэх|үү|уу$|бол$/i.test(label) });
        }
        continue;
      }
    }

    const numberedBold = trimmed.match(/^\d+\.\s*\*\*([^*]+)\*\*/);
    if (numberedBold) {
      const label = numberedBold[1].trim().replace(/:$/, '');
      if (label.length >= 3 && label.length <= 80) {
        steps.push({ label, isDecision: /\?|эсэх|үү|уу$|бол$/i.test(label) });
      }
      continue;
    }

    const standaloneBold = trimmed.match(/^\*\*(\d+\.\s*)?([^*]{4,60})\*\*\s*$/);
    if (standaloneBold) {
      const label = (standaloneBold[2] ?? '').trim().replace(/:$/, '');
      if (label.length >= 3) {
        steps.push({ label, isDecision: /\?|эсэх|үү|уу$|бол$/i.test(label) });
      }
    }
  }

  return steps.slice(0, 6);
}

function ArrowDown() {
  return (
    <div className="flex justify-center py-1">
      <svg className="h-5 w-5 text-gray-300 dark:text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

const STEP_COLORS = [
  'flow-step-blue',
  'flow-step-green',
  'flow-step-purple',
  'flow-step-amber',
  'flow-step-rose',
  'flow-step-cyan',
];

function StepNode({ step, index }: { step: FlowStep; index: number }) {
  if (step.isDecision) {
    return (
      <div className="flex justify-center">
        <div className="flow-decision">
          <span className="text-xs font-semibold">{step.label}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-center">
      <div className={`flow-step ${STEP_COLORS[index % STEP_COLORS.length]}`}>
        <span className="flow-step-number">{index + 1}</span>
        <span className="text-xs font-medium">{step.label}</span>
      </div>
    </div>
  );
}

export function DecisionFlowchart({ steps }: { steps: FlowStep[] }) {
  if (steps.length < 2) return null;

  return (
    <div className="flow-container">
      {steps.map((step, idx) => (
        <div key={idx}>
          <StepNode step={step} index={idx} />
          {idx < steps.length - 1 && <ArrowDown />}
        </div>
      ))}
    </div>
  );
}
