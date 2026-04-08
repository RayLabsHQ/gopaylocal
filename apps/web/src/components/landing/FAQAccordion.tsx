import {
  AnimatedAccordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/animated-accordion';
import { faqItems } from '@/lib/landing-data';

export default function FAQAccordion() {
  return (
    <AnimatedAccordion
      type="multiple"
      defaultValue="item-0"
      accentColor="#CA3F16"
      className="max-w-3xl"
    >
      {faqItems.map((item, i) => (
        <AccordionItem key={i} value={`item-${i}`}>
          <AccordionTrigger>{item.question}</AccordionTrigger>
          <AccordionContent>{item.answer}</AccordionContent>
        </AccordionItem>
      ))}
    </AnimatedAccordion>
  );
}
