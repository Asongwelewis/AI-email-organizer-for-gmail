import { ArrowRight, Check, LockKeyhole, MousePointer2 } from 'lucide-react';
import { motion, useScroll, useTransform } from 'motion/react';
import { Link } from 'react-router-dom';

import heroImage from '@web/assets/mailmind-editorial-hero.png';
import { BrandMark } from '@web/components/BrandMark';

const principles = [
  {
    number: '01',
    title: 'Suggestions, not surprises',
    copy: 'MailMind finds useful patterns in synchronized Gmail metadata and turns them into label suggestions for you to review.',
  },
  {
    number: '02',
    title: 'Your decision comes first',
    copy: 'Approve, reject, defer, or refine each suggestion. A review decision never changes your Gmail messages or labels.',
  },
  {
    number: '03',
    title: 'Permission on your terms',
    copy: 'Google sign-in and Gmail access stay separate. You can disconnect Gmail without deleting your MailMind account.',
  },
] as const;

const workflow = [
  {
    title: 'Sign in with Google.',
    copy: 'Create your MailMind identity using your basic Google profile. This step does not grant Gmail access.',
  },
  {
    title: 'Connect Gmail.',
    copy: 'Authorize Gmail separately, then synchronize the message metadata MailMind needs to find organization patterns.',
  },
  {
    title: 'Review suggested labels.',
    copy: 'MailMind groups recurring senders and topics into controlled label suggestions with clear reasons.',
  },
  {
    title: 'Approve or reject suggestions.',
    copy: 'Keep, refine, defer, or reject each idea. Your review is recorded, but Gmail is not changed at this stage.',
  },
] as const;

export function LandingPage() {
  const { scrollYProgress } = useScroll();
  const imageY = useTransform(scrollYProgress, [0, 0.45], [0, 54]);

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
            <span /> A human-reviewed Gmail organizer
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            MailMind <em>AI</em>
          </motion.h1>
          <motion.p
            className="landing-hero__promise"
            initial={{ opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            Thoughtful Gmail organization,
            <br />
            with every suggestion reviewed by you.
          </motion.p>
          <motion.p
            className="landing-hero__lede"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.38 }}
          >
            MailMind AI securely analyzes synchronized Gmail metadata to identify recurring senders
            and topics, then suggests useful labels for you to approve or reject. Reviewing a
            suggestion does not change Gmail at this stage.
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
            Made to recommend.
            <br />
            Built to ask first.
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
            <span className="eyebrow">How it works</span>
            <h2 id="workflow-title" aria-label="Four clear steps. Every choice stays yours.">
              Four clear steps.
              <br />
              Every choice stays yours.
            </h2>
            <p>
              From secure sign-in to label review, MailMind keeps identity, Gmail permission, and
              every organization decision explicit.
            </p>
          </div>
          <ol className="workflow-steps">
            {workflow.map((step, index) => (
              <motion.li
                key={step.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.35 }}
                transition={{ delay: index * 0.08 }}
              >
                <div className="workflow-step__meta">
                  <span>0{index + 1}</span>
                  <Check aria-hidden="true" />
                </div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      <section className="landing-final-cta">
        <BrandMark compact />
        <h2>Bring calm to the review queue.</h2>
        <p>
          Start with a secure MailMind AI identity. Connect Gmail only when you choose, and keep
          every label suggestion under your control.
        </p>
        <Link className="cta-link cta-link--paper" to="/login">
          Continue with Google <ArrowRight aria-hidden="true" />
        </Link>
      </section>
    </>
  );
}
