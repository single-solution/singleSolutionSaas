import { LoginAside } from "@/components/auth/LoginAside";
import { LoginCredentialsForm } from "@/components/auth/LoginCredentialsForm";
import { resolveChatbotPublicDemoUrl } from "@/lib/demo/chatbotPublicDemoUrl";

export default function LoginPage() {
  const demoUrl = resolveChatbotPublicDemoUrl();

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-2">
      <LoginAside demoUrl={demoUrl} />
      <LoginCredentialsForm demoUrl={demoUrl} />
    </div>
  );
}
