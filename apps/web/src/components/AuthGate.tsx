import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  API_BASE_URL,
  setApiBearerToken,
} from '../config/api'
import './AuthGate.css'

type GoogleCredentialResponse = {
  credential?: string
}

type GoogleIdentity = {
  initialize: (options: {
    client_id: string
    callback: (
      response: GoogleCredentialResponse,
    ) => void
  }) => void
  renderButton: (
    parent: HTMLElement,
    options: {
      theme: 'outline'
      size: 'large'
      text: 'signin_with'
      shape: 'rectangular'
    },
  ) => void
  disableAutoSelect: () => void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: GoogleIdentity
      }
    }
  }
}

type CommerceHubUser = {
  email: string
  role: 'VIEWER' | 'ADMIN'
}

type SessionResponse = {
  status?: string
  user?: CommerceHubUser
  message?: string
}

const SESSION_STORAGE_KEY =
  'commerce-hub-google-credential'

const authProvider =
  import.meta.env.VITE_COMMERCE_HUB_AUTH_PROVIDER
    ?.trim()
    .toLowerCase()

const googleClientId =
  import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim()

function loadGoogleIdentityScript() {
  if (window.google?.accounts.id) {
    return Promise.resolve()
  }

  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-commerce-hub-google-identity]',
  )

  if (existing) {
    return new Promise<void>((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), {
        once: true,
      })
      existing.addEventListener(
        'error',
        () => reject(new Error('A Google belépés nem tölthető be.')),
        { once: true },
      )
    })
  }

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.commerceHubGoogleIdentity = 'true'
    script.onload = () => resolve()
    script.onerror = () =>
      reject(
        new Error('A Google belépés nem tölthető be.'),
      )
    document.head.append(script)
  })
}

export default function AuthGate({
  children,
}: {
  children: ReactNode
}) {
  const buttonContainerRef =
    useRef<HTMLDivElement>(null)
  const [user, setUser] =
    useState<CommerceHubUser | null>(null)
  const [loading, setLoading] = useState(() =>
    authProvider === 'google' &&
    Boolean(
      sessionStorage.getItem(SESSION_STORAGE_KEY),
    ),
  )
  const [error, setError] = useState<string | null>(
    null,
  )

  const clearSession = useCallback(() => {
    sessionStorage.removeItem(SESSION_STORAGE_KEY)
    setApiBearerToken(null)
    setUser(null)
    setLoading(false)
  }, [])

  const validateCredential = useCallback(
    async (credential: string) => {
      setLoading(true)
      setError(null)
      setApiBearerToken(credential)

      try {
        const response = await fetch(
          `${API_BASE_URL}/auth/session`,
        )
        const result =
          (await response.json()) as SessionResponse

        if (!response.ok || !result.user) {
          throw new Error(
            result.message ??
              'A fiók nem jogosult a Commerce Hub használatára.',
          )
        }

        sessionStorage.setItem(
          SESSION_STORAGE_KEY,
          credential,
        )
        setUser(result.user)
      } catch (validationError) {
        clearSession()
        setError(
          validationError instanceof Error
            ? validationError.message
            : 'A bejelentkezés ellenőrzése sikertelen.',
        )
      } finally {
        setLoading(false)
      }
    },
    [clearSession],
  )

  useEffect(() => {
    if (authProvider !== 'google') return

    const storedCredential =
      sessionStorage.getItem(SESSION_STORAGE_KEY)

    if (!storedCredential) return

    let cancelled = false

    queueMicrotask(() => {
      if (!cancelled) {
        void validateCredential(storedCredential)
      }
    })

    return () => {
      cancelled = true
    }
  }, [validateCredential])

  useEffect(() => {
    if (
      authProvider !== 'google' ||
      user ||
      loading ||
      !googleClientId
    ) {
      return
    }

    let cancelled = false

    void loadGoogleIdentityScript()
      .then(() => {
        if (
          cancelled ||
          !window.google ||
          !buttonContainerRef.current
        ) {
          return
        }

        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (response) => {
            if (response.credential) {
              void validateCredential(
                response.credential,
              )
            }
          },
        })

        buttonContainerRef.current.replaceChildren()
        window.google.accounts.id.renderButton(
          buttonContainerRef.current,
          {
            theme: 'outline',
            size: 'large',
            text: 'signin_with',
            shape: 'rectangular',
          },
        )
      })
      .catch((scriptError) => {
        if (!cancelled) {
          setError(
            scriptError instanceof Error
              ? scriptError.message
              : 'A Google belépés nem tölthető be.',
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [loading, user, validateCredential])

  useEffect(() => {
    const handleUnauthorized = () => {
      clearSession()
      setError(
        'A munkamenet lejárt. Jelentkezz be újra.',
      )
    }

    window.addEventListener(
      'commerce-hub:auth-required',
      handleUnauthorized,
    )

    return () => {
      window.removeEventListener(
        'commerce-hub:auth-required',
        handleUnauthorized,
      )
    }
  }, [clearSession])

  if (authProvider !== 'google') {
    return children
  }

  if (!googleClientId) {
    return (
      <main className="auth-gate">
        <section className="auth-card">
          <span className="auth-eyebrow">Commerce Hub</span>
          <h1>A Google-belépés nincs beállítva</h1>
          <p>
            A frontend környezeti változói közül hiányzik a
            Google OAuth kliensazonosító.
          </p>
        </section>
      </main>
    )
  }

  if (!user) {
    return (
      <main className="auth-gate">
        <section className="auth-card">
          <span className="auth-eyebrow">Kärcher</span>
          <h1>Commerce Hub</h1>
          <p>
            Jelentkezz be az engedélyezett Google-fiókoddal.
          </p>

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          {loading ? (
            <div className="auth-loading">
              Bejelentkezés ellenőrzése…
            </div>
          ) : (
            <div
              className="auth-google-button"
              ref={buttonContainerRef}
            />
          )}
        </section>
      </main>
    )
  }

  return (
    <>
      <div className="auth-session-bar">
        <span>
          {user.email} ·{' '}
          {user.role === 'ADMIN'
            ? 'Adminisztrátor'
            : 'Megtekintő'}
        </span>
        <button
          type="button"
          onClick={() => {
            window.google?.accounts.id.disableAutoSelect()
            clearSession()
          }}
        >
          Kijelentkezés
        </button>
      </div>
      {children}
    </>
  )
}
