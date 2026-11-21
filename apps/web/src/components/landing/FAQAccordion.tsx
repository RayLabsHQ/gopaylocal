import { useState } from 'react';
import { cn } from '@/lib/utils';
import { faqItems } from '@/lib/landing-data';

export default function FAQAccordion() {
  const [openItems, setOpenItems] = useState<number[]>([0]);

  const toggle = (i: number) =>
    setOpenItems((prev) =>
      prev.includes(i) ? prev.filter((v) => v !== i) : [...prev, i],
    );

  return (
    <div className="max-w-3xl border-t border-border">
      {faqItems.map((item, i) => {
        const isOpen = openItems.includes(i);

        return (
          <div key={i} className="border-b border-border">
            <button
              type="button"
              onClick={() => toggle(i)}
              aria-expanded={isOpen}
              aria-controls={`faq-answer-${i}`}
              className="w-full flex items-start justify-between gap-6 py-5 text-left cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              <span
                className={cn(
                  'font-display text-lg font-semibold leading-snug transition-colors duration-200',
                  isOpen ? 'text-accent-text' : 'text-text-primary',
                )}
              >
                {item.question}
              </span>

              <span aria-hidden="true" className="relative mt-1.5 h-3 w-3 shrink-0">
                <span
                  className={cn(
                    'absolute top-1/2 left-0 h-[2px] w-3 -translate-y-1/2 transition-colors duration-200',
                    isOpen ? 'bg-accent-500' : 'bg-text-secondary',
                  )}
                />
                <span
                  className={cn(
                    'absolute left-1/2 top-0 h-3 w-[2px] -translate-x-1/2 bg-text-secondary transition-transform duration-200',
                    isOpen ? 'scale-y-0' : 'scale-y-100',
                  )}
                />
              </span>
            </button>

            <div
              id={`faq-answer-${i}`}
              role="region"
              aria-hidden={!isOpen}
              className={cn(
                'grid transition-[grid-template-rows,opacity] duration-300 ease-out',
                isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
              )}
            >
              <div className="overflow-hidden">
                <p className="max-w-prose border-l-2 border-accent-500 pl-4 pb-5 text-base text-text-secondary leading-relaxed">
                  {item.answer}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
