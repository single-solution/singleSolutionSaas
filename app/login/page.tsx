import { LoginAside } from "@/components/auth/LoginAside";
import { LoginCredentialsForm } from "@/components/auth/LoginCredentialsForm";

export default function LoginPage() {
  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-2">
      <LoginAside />
      <LoginCredentialsForm />
    </div>
  );
}
