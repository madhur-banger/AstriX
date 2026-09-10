import LegalPage from "./legal-layout";

// TODO(legal): replace the contact placeholders below with the real operating
// entity, registered address and support address before launch, and have the
// whole document reviewed by counsel.
const TermsOfService = () => {
  return (
    <LegalPage title="Terms of Service" lastUpdated="Not yet published">
      <section>
        <h2>1. Agreement to these terms</h2>
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your access to and
          use of the AstriX workspace, project and task management service (the
          &quot;Service&quot;). By creating an account, joining a workspace, or
          otherwise using the Service, you agree to be bound by these Terms. If
          you are using the Service on behalf of an organisation, you confirm
          that you have authority to bind that organisation.
        </p>
      </section>

      <section>
        <h2>2. Accounts</h2>
        <p>
          You must provide accurate account information and keep it up to date.
          You are responsible for safeguarding your credentials and for all
          activity that occurs under your account. Notify us promptly if you
          believe your account has been compromised. You must be old enough to
          form a binding contract in your jurisdiction to use the Service.
        </p>
      </section>

      <section>
        <h2>3. Workspaces, roles and content</h2>
        <p>
          The Service is organised into workspaces. A workspace owner or
          administrator controls membership, roles and permissions, and can
          view, modify, export or delete content within their workspace,
          including content you contribute. Content you submit remains yours;
          you grant us the limited licence needed to host, process, transmit and
          display it in order to operate the Service.
        </p>
      </section>

      <section>
        <h2>4. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>
            break the law or infringe anyone&apos;s rights using the Service;
          </li>
          <li>
            upload malware, or attempt to gain unauthorised access to the
            Service, other accounts or the underlying infrastructure;
          </li>
          <li>
            probe, scan, overload or otherwise interfere with the Service or
            circumvent its rate limits and access controls;
          </li>
          <li>
            resell, sublicense or make the Service available to third parties
            outside your workspace without our written permission.
          </li>
        </ul>
      </section>

      <section>
        <h2>5. Fees</h2>
        <p>
          Any paid plans, billing intervals, taxes and refund conditions will be
          described at the point of purchase and form part of these Terms. Where
          the Service is offered free of charge, we may change or discontinue
          the free offering on reasonable notice.
        </p>
      </section>

      <section>
        <h2>6. Service availability and changes</h2>
        <p>
          We work to keep the Service available and reliable, but it is provided
          on an &quot;as is&quot; and &quot;as available&quot; basis without
          warranties of any kind, to the fullest extent permitted by law. We may
          add, change or remove features, and we may perform maintenance that
          temporarily interrupts availability.
        </p>
      </section>

      <section>
        <h2>7. Suspension and termination</h2>
        <p>
          You may stop using the Service and delete your account at any time. We
          may suspend or terminate access if you materially breach these Terms,
          if required by law, or if your use poses a security or operational
          risk to the Service or other users. On termination, we will delete or
          de-identify your data in line with our Privacy Policy and applicable
          retention obligations.
        </p>
      </section>

      <section>
        <h2>8. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, we are not liable for
          indirect, incidental, special, consequential or punitive damages, or
          for lost profits, revenue or data. Our aggregate liability arising out
          of or relating to the Service is limited to the amounts you paid us
          for the Service in the twelve months preceding the event giving rise
          to the claim.
        </p>
      </section>

      <section>
        <h2>9. Changes to these terms</h2>
        <p>
          We may update these Terms from time to time. If a change is material,
          we will give reasonable notice - for example by email or an in-product
          notice - before it takes effect. Continuing to use the Service after
          the effective date means you accept the updated Terms.
        </p>
      </section>

      <section>
        <h2>10. Governing law</h2>
        <p>
          These Terms are governed by the laws of [governing jurisdiction], and
          the courts of [governing jurisdiction] have exclusive jurisdiction
          over any dispute, without regard to conflict-of-law rules.
        </p>
      </section>

      <section>
        <h2>11. Contact</h2>
        <p>
          Questions about these Terms can be sent to [contact email], [operating
          entity and registered address].
        </p>
      </section>
    </LegalPage>
  );
};

export default TermsOfService;
