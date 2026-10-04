import { ShieldCheck } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "./api";
import type { User } from "./api";

const Dashboard = lazy(() => import("./Dashboard"));

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    api
      .me(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setUser(result.user);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUser(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCheckingSession(false);
      });
    return () => controller.abort();
  }, []);

  if (checkingSession) {
    return <FullScreenState title="Проверяем сессию" />;
  }

  if (!user) {
    return <LoginScreen onLogin={setUser} />;
  }

  return (
    <Suspense fallback={<FullScreenState title="Загружаем панель" />}>
      <Dashboard key={`${user.role}:${user.email}`} user={user} onLogout={() => setUser(null)} />
    </Suspense>
  );
}

function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const result = await api.login(email, password);
      onLogin(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось войти");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-label="Авторизация">
        <div className="brand-mark">
          <ShieldCheck size={24} />
        </div>
        <h1>Naliv Analytics</h1>
        <p>Продажи, магазины и запасы — в одной рабочей панели.</p>

        <form onSubmit={submit} className="login-form">
          <label>
            Электронная почта
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error ? <div className="form-error">{error}</div> : null}
          <button type="submit" disabled={submitting}>
            {submitting ? "Вход..." : "Войти"}
          </button>
        </form>
      </section>
    </main>
  );
}

function FullScreenState({ title }: { title: string }) {
  return (
    <div className="boot-state">
      <div className="loader" />
      <span>{title}</span>
    </div>
  );
}
