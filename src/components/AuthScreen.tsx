import { useState, type FormEvent } from 'react'
import { ArrowRight, LockKeyhole, Mail, ShieldCheck } from 'lucide-react'
import { z } from 'zod'
import { ApiError, apiRequest, signIn, signUp, type UserProfile } from '../lib/api'

const signInSchema = z.object({
  email: z.email('Geçerli bir e-posta adresi girin.'),
  password: z.string().min(1, 'Parola zorunludur.'),
})

const signUpSchema = signInSchema.extend({
  name: z.string().trim().min(2, 'Ad soyad en az 2 karakter olmalıdır.'),
  password: z.string().min(8, 'Parola en az 8 karakter olmalıdır.'),
  passwordConfirmation: z.string().min(8, 'Parola tekrarı en az 8 karakter olmalıdır.'),
}).refine((value) => value.password === value.passwordConfirmation, { message: 'Parolalar eşleşmiyor.', path: ['passwordConfirmation'] })

type AuthScreenProps = { onAuthenticated: (user: UserProfile) => void }

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const schema = mode === 'login' ? signInSchema : signUpSchema
    const parsed = schema.safeParse(mode === 'login' ? { email, password } : { name, email, password, passwordConfirmation })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Girdi bilgilerini kontrol edin.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'login') await signIn(email, password)
      else await signUp(name.trim(), email, password)
      const user = await apiRequest<UserProfile>('/api/me')
      onAuthenticated(user)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'İşlem tamamlanamadı.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-brand-mark" aria-hidden="true"><span>Ü</span></div>
      <div className="auth-layout">
        <section className="auth-intro">
          <div className="eyebrow light-eyebrow">ORDU · EĞİTİM TEKNOLOJİLERİ</div>
          <h1>Merakla başlayan<br /><em>projeler burada</em><br />hayata geçiyor.</h1>
          <p>Ünye Bilim ve Sanat Merkezi proje takip sistemi; öğrenci çalışmalarını, ekipleri ve akademik yıl yolculuklarını tek yerde buluşturur.</p>
          <div className="auth-trust"><ShieldCheck size={17} /><span>Güvenli kurum hesabı erişimi</span></div>
          <div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" />
          <div className="auth-intro-footer">ÜNYE BİLİM VE SANAT MERKEZİ <span>•</span> ORDU</div>
        </section>

        <section className="auth-card-wrap">
          <div className="auth-card">
            <div className="auth-card-heading">
              <div className="auth-small-brand"><span>Ü</span><div><strong>BİLSEM</strong><small>PROJE TAKİP</small></div></div>
              <div className="auth-step">{mode === 'login' ? '01 / OTURUM' : '01 / HESAP'}</div>
            </div>
            <div className="auth-title-block">
              <h2>{mode === 'login' ? 'Tekrar hoş geldiniz' : 'Kurum hesabı oluşturun'}</h2>
              <p>{mode === 'login' ? 'Devam etmek için kurum hesabınızla giriş yapın.' : 'Yeni hesaplar öğretmen rolüyle oluşturulur.'}</p>
            </div>
            <form onSubmit={submit} className="auth-form">
              {mode === 'register' && (
                <label className="field-label">Ad soyad
                  <div className="input-wrap"><input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Adınız Soyadınız" required /><span className="input-icon">A</span></div>
                </label>
              )}
              <label className="field-label">E-posta adresi
                <div className="input-wrap"><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ornek@kurum.edu.tr" required /><Mail className="input-icon" size={17} /></div>
              </label>
              <label className="field-label">Parola
                <div className="input-wrap"><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === 'login' ? 'Parolanızı girin' : 'En az 8 karakter'} required /><LockKeyhole className="input-icon" size={17} /></div>
              </label>
              {mode === 'register' && <label className="field-label">Parola tekrarı<div className="input-wrap"><input type="password" autoComplete="new-password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} placeholder="Parolanızı yeniden girin" required /><LockKeyhole className="input-icon" size={17} /></div></label>}
              {error && <div className="form-error" role="alert">{error}</div>}
              <button className="button button-primary auth-submit" disabled={busy} type="submit">
                {busy ? 'Kontrol ediliyor…' : mode === 'login' ? 'Giriş yap' : 'Öğretmen hesabı oluştur'}
                {!busy && <ArrowRight size={17} />}
              </button>
            </form>
            <div className="auth-switch">
              {mode === 'login' ? 'İlk kez mi kullanıyorsunuz?' : 'Zaten hesabınız var mı?'}{' '}
              <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>
                {mode === 'login' ? 'Öğretmen hesabı oluşturun' : 'Giriş yapın'}
              </button>
            </div>
            <div className="auth-card-foot"><span>ÜNYE BİLSEM</span><span>YARDIM VE DESTEK</span></div>
          </div>
          <div className="auth-outside-note">Bu uygulama yalnızca yetkili kurum kullanıcılarının erişimine açıktır.</div>
        </section>
      </div>
    </main>
  )
}
