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
      <div className="login-brandband" aria-hidden />
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-mark" dangerouslySetInnerHTML={{ __html: towerMark(40) }} />
        <h1 className="login-word">Ghost Tower</h1>
        <p className="login-sub">Operations console — authorized access only</p>

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

        {error && (
          <p className="login-error" role="alert">
            Incorrect username or password.
          </p>
        )}

        <button type="submit" className="login-submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
