import LegalPage from "./legal-layout";

// TODO(legal): replace the contact/controller placeholders below with the real
// operating entity, DPO or privacy contact and sub-processor list before
// launch, and have the whole document reviewed by counsel.
const PrivacyPolicy = () => {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="Not yet published">
      <section>
        <h2>1. Who this policy covers</h2>
        <p>
          This policy explains what personal data the AstriX workspace, project
          and task management service (the &quot;Service&quot;) collects, why we
          collect it, and what you can do about it. The data controller is
          [operating entity and registered address].
        </p>
      </section>

      <section>
        <h2>2. Data we collect</h2>
        <ul>
          <li>
            <strong>Account data</strong> - your name, email address, profile
            picture, password hash (we never store your password in plain text)
            and, if you sign in with Google, the account identifier and basic
            profile fields that Google returns.
          </li>
          <li>
            <strong>Workspace content</strong> - workspaces, projects, tasks,
            descriptions, due dates, assignments and membership roles that you
            or your teammates create.
          </li>
          <li>
            <strong>Session and security data</strong> - the sessions attached
            to your account, including approximate sign-in time, IP address and
            browser user-agent, so that you can review and revoke access from
            devices you no longer use.
          </li>
          <li>
            <strong>Operational logs</strong> - request metadata and error
            diagnostics used to keep the Service running, secure and debuggable.
          </li>
        </ul>
      </section>

      <section>
        <h2>3. Cookies and authentication tokens</h2>
        <p>
          Signing in issues a short-lived access token, held only in your
          browser&apos;s memory, and a longer-lived refresh token stored in an
          httpOnly cookie that your browser sends back to us automatically. That
          cookie is strictly necessary to keep you signed in - it is not used
          for advertising or cross-site tracking. Clearing it, or revoking the
          matching session, signs you out.
        </p>
      </section>

      <section>
        <h2>4. Why we process your data</h2>
        <ul>
          <li>to provide the Service and the features you ask for;</li>
          <li>
            to authenticate you, prevent abuse and protect accounts and data;
          </li>
          <li>
            to send service messages such as email verification, password resets
            and workspace invitations;
          </li>
          <li>to diagnose faults, and to maintain and improve the Service;</li>
          <li>to meet legal, accounting and security obligations.</li>
        </ul>
        <p>
          Where the law requires a lawful basis, we rely on performance of our
          contract with you, our legitimate interest in operating and securing
          the Service, and your consent where consent is specifically requested.
        </p>
      </section>

      <section>
        <h2>5. Sharing</h2>
        <p>
          We do not sell your personal data. Content you add to a workspace is
          visible to other members of that workspace according to their role. We
          share data with service providers who host and operate the Service on
          our behalf - for example cloud hosting, database, and email delivery
          providers - under contracts that limit their use of it, and with
          authorities where we are legally required to do so.
        </p>
      </section>

      <section>
        <h2>6. Retention</h2>
        <p>
          We keep account and workspace data for as long as your account is
          active. When you delete your account we delete or de-identify your
          personal data, except where we must retain it to comply with legal
          obligations, resolve disputes or enforce our agreements. Sessions
          expire automatically and revoked sessions stop working immediately.
        </p>
      </section>

      <section>
        <h2>7. Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access,
          correct, export, restrict, or delete your personal data, to object to
          certain processing, and to withdraw consent. You can update your
          profile and delete your account from your account settings, and you
          can revoke individual sessions at any time. To exercise any other
          right, or to complain to a supervisory authority, contact us using the
          details below.
        </p>
      </section>

      <section>
        <h2>8. Security</h2>
        <p>
          We use industry-standard measures including encrypted transport,
          hashed passwords, httpOnly refresh-token cookies, server-side session
          revocation and role-based access control within workspaces. No system
          is perfectly secure, so please use a strong, unique password and
          revoke sessions you do not recognise.
        </p>
      </section>

      <section>
        <h2>9. International transfers</h2>
        <p>
          Your data may be processed in countries other than your own. Where it
          is, we rely on appropriate safeguards such as standard contractual
          clauses with the providers involved.
        </p>
      </section>

      <section>
        <h2>10. Children</h2>
        <p>
          The Service is not directed at children, and we do not knowingly
          collect personal data from anyone below the minimum age required to
          consent to online services in their jurisdiction.
        </p>
      </section>

      <section>
        <h2>11. Changes and contact</h2>
        <p>
          We will post any changes to this policy on this page and, where the
          change is material, give reasonable notice before it takes effect.
          Privacy questions and rights requests can be sent to [contact email].
        </p>
      </section>
    </LegalPage>
  );
};

export default PrivacyPolicy;
