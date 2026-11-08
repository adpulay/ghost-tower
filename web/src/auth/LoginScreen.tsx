import { useState, type FormEvent } from "react";
import { towerMark } from "../shell/symbols";
import { useAuth } from "./AuthContext";

export function LoginScreen() {
  const { signIn } = useAuth();
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!signIn(user, pass)) setError(true);
  }

  return (
    <div className="login">
      <aside className="login-brand">
        <span className="login-mark" dangerouslySetInnerHTML={{ __html: towerMark(104) }} />
        <div className="login-brand-mid">
          <h1 className="login-word">Ghost Tower</h1>
          <p className="login-kicker">Fake base-station detection network</p>
        </div>
        <p className="login-foot">Crowd-sourced alerts from phones in the field, scored and mapped in one console.</p>
      </aside>

      <main className="login-panel">
        <form className="login-form" onSubmit={onSubmit}>
          <h2 className="login-h2">Sign in</h2>
          <p className="login-lead">Operator access to the detection console.</p>

          {error && (
            <p className="login-error" role="alert">
              That username or password didn’t match.
            </p>
          )}

          <label className="login-field">
            <span>Username</span>
            <input
              name="username"
              autoComplete="username"
              autoFocus
              value={user}
              onChange={(e) => {
                setUser(e.target.value);
                setError(false);
              }}
            />
          </label>

          <label className="login-field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={pass}
              onChange={(e) => {
                setPass(e.target.value);
                setError(false);
              }}
            />
          </label>

          <button type="submit" className="login-submit">
            Sign in
          </button>

          <p className="login-fine">Authorized operators only.</p>
        </form>
      </main>
    </div>
  );
}
