import ResetPassword from './reset';

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  return <ResetPassword token={token ?? ''} linkError={error}/>;
}
