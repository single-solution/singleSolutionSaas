import { resolveChatbotPublicDemoUrl } from "@/lib/demo/chatbotPublicDemoUrl";

interface ChatbotTryLiveDemoLinkProps {
  className?: string;
  children?: React.ReactNode;
}

/** Guest-safe link to the ecommerce chatbot public sandbox. */
export function ChatbotTryLiveDemoLink({
  className,
  children,
}: ChatbotTryLiveDemoLinkProps) {
  const href = resolveChatbotPublicDemoUrl();
  if (!href) {
    return null;
  }
  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children ?? "Try live demo"}
    </a>
  );
}
