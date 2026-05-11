'use client';

interface SuggestedQuestionsProps {
  questions: string[];
  onQuestionClick: (question: string) => void;
}

function ChatBubbleIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SuggestedQuestions({ questions, onQuestionClick }: SuggestedQuestionsProps) {
  if (!questions || questions.length === 0) return null;

  return (
    <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
      <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">
        Төстэй асуултууд
      </p>
      <div className="flex flex-col gap-1.5">
        {questions.map((question, idx) => (
          <button
            key={idx}
            onClick={() => onQuestionClick(question)}
            className="group flex items-start gap-2 rounded-lg border border-gray-200 bg-white/60 px-3 py-2 text-left text-sm text-gray-700 transition-all hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:border-primary-600/50 dark:hover:bg-primary-900/20 dark:hover:text-primary-300"
          >
            <span className="mt-0.5 shrink-0 text-gray-400 transition-colors group-hover:text-primary-500 dark:text-gray-500">
              <ChatBubbleIcon />
            </span>
            <span>{question}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
