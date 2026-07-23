import { useState } from 'react';
import { ArrowRight, Check, LockKeyhole, MousePointer2, ShieldCheck } from 'lucide-react';
import { AnimatePresence, motion, useScroll, useTransform } from 'motion/react';
import { Link } from 'react-router-dom';

import heroImage from '@web/assets/mailmind-editorial-hero.png';
import { BrandMark } from '@web/components/BrandMark';

const principles = [
  {
    number: '01',
    title: 'Identity first',
    copy: 'Sign in with Google without granting MailMind access to Gmail. The two permissions stay separate.',
  },
  {
    number: '02',
    title: 'Permission on your terms',
    copy: 'Connect or disconnect one Gmail account whenever you choose. Your MailMind account stays intact.',
  },
  {
    number: '03',
    title: 'A quieter future inbox',
    copy: 'Stage 2 establishes the secure foundation. Organization features arrive later—and never pretend to be active now.',
  },
] as const;

const workflow = [
  {
    id: 'signin',
    label: 'Sign in',
    title: 'One identity. No inbox permission.',
    copy: 'Google confirms who you are using only your basic profile. Gmail access is not bundled into login.',
  },
  {
    id: 'connect',
    label: 'Connect',
    title: 'Gmail stays a separate decision.',
    copy: 'When you are ready, authorize the Gmail permission MailMind will need for future organization tools.',
  },
  {
    id: 'control',
    label: 'Stay in control',
    title: 'Disconnect without disappearing.',
    copy: 'Remove Gmail access at any time without deleting your MailMind identity or ending your current session.',
  },
] as const;

export function LandingPage() {
  const [activeStep, setActiveStep] = useState<(typeof workflow)[number]['id']>('signin');
  const { scrollYProgress } = useScroll();
  const imageY = useTransform(scrollYProgress, [0, 0.45], [0, 54]);
  const current = workflow.find((step) => step.id === activeStep)!;

  return (
    <>
      <section className="landing-hero">
        <div className="landing-hero__copy">
          <motion.div
            className="landing-kicker"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
          >
            <span /> Calm starts with a clear boundary
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            Your inbox,
            <br />
            <em>composed.</em>
          </motion.h1>
          <motion.p
            className="landing-hero__lede"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.38 }}
          >
            MailMind is building a more deliberate way to organize Gmail—starting with secure,
            separate permissions that keep you in control.
          </motion.p>
          <motion.div
            className="landing-hero__actions"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
          >
            <Link className="cta-link" to="/login" data-cursor>
              Begin with Google <ArrowRight aria-hidden="true" />
            </Link>
            <span className="privacy-note">
              <LockKeyhole aria-hidden="true" /> No Gmail access at sign-in
            </span>
          </motion.div>
        </div>

        <motion.figure
          className="landing-hero__visual"
          initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }}
          animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }}
          transition={{ duration: 1.15, delay: 0.2, ease: [0.76, 0, 0.24, 1] }}
          style={{ y: imageY }}
        >
          <img
            src={heroImage}
            alt="Artful paper correspondence arranged into an organized filing system"
          />
          <figcaption>
            <span>MailMind study № 01</span>
            <span>Order without overreach</span>
          </figcaption>
        </motion.figure>

        <div className="scroll-cue" aria-hidden="true">
          <MousePointer2 /> <span>Scroll to unfold</span>
        </div>
      </section>

      <section className="principles-section" id="principles" aria-labelledby="principles-title">
        <div className="section-intro">
          <span className="eyebrow">The operating principles</span>
          <h2 id="principles-title">
            Useful by design.
            <br />
            Restrained by default.
          </h2>
        </div>
        <div className="principles-grid">
          {principles.map((principle, index) => (
            <motion.article
              key={principle.number}
              className="principle-card"
              initial={{ opacity: 0, y: 28 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ delay: index * 0.1 }}
            >
              <span className="principle-card__number">{principle.number}</span>
              <h3>{principle.title}</h3>
              <p>{principle.copy}</p>
              <Check aria-hidden="true" />
            </motion.article>
          ))}
        </div>
      </section>

      <section className="workflow-section" id="how-it-works" aria-labelledby="workflow-title">
        <div className="workflow-panel">
          <div className="workflow-panel__header">
            <span className="eyebrow">The permission sequence</span>
            <h2 id="workflow-title">
              Three moments.
              <br />
              Each one explicit.
            </h2>
          </div>
          <div className="workflow-tabs" role="tablist" aria-label="Permission sequence">
            {workflow.map((step) => (
              <button
                key={step.id}
                type="button"
                role="tab"
                aria-selected={activeStep === step.id}
                aria-controls="workflow-detail"
                onClick={() => setActiveStep(step.id)}
              >
                {activeStep === step.id && <motion.span layoutId="workflow-tab" />}
                <b>{step.label}</b>
              </button>
            ))}
          </div>
          <div className="workflow-detail" id="workflow-detail" role="tabpanel" aria-live="polite">
            <AnimatePresence mode="wait">
              <motion.div
                key={current.id}
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.28 }}
              >
                <ShieldCheck aria-hidden="true" />
                <h3>{current.title}</h3>
                <p>{current.copy}</p>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </section>

      <section className="landing-final-cta">
        <BrandMark compact />
        <h2>Make room for what matters.</h2>
        <p>Start with a secure MailMind identity. Connect Gmail only when you choose.</p>
        <Link className="cta-link cta-link--paper" to="/login">
          Continue with Google <ArrowRight aria-hidden="true" />
        </Link>
      </section>
    </>
  );
}
